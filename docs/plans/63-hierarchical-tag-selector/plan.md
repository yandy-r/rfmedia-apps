# Implementation Plan — Issue #63 `[rfapps-cli] Hierarchical Service Tagging`

**Worktree (the only tree; every path below is relative to it):**
`/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-feat-63-tagging`
**Branch:** `feat/63-hierarchical-service-tagging` · **Base:** `master` @ `c54b647b`
**Authoritative design:** `docs/plans/63-hierarchical-tag-selector/design.md` (1453 lines)
**PR title (changelog line, verbatim):** `feat(rfapps): add hierarchical tag selector for service targeting (#63)` · **PR body says `Closes #63`.**

> This is the **repaired** plan. Twelve blocking defects raised by four adversarial validators were each verified against the real tree and fixed; §7 records every repair with evidence. Eleven of twelve were confirmed; one validator _fix_ (defect 1, option (a)) was rejected as wrong and replaced. The batch count grew from 9 to 10 and two tasks were re-batched.

## Maintainer overrides applied throughout

| #        | Override                                          | Effect on this plan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MO-1** | **Read-only v1 is approved; this PR CLOSES #63.** | No task builds `rfapps tag set/add/remove` and no task adds `--apply` to any tag surface. Design §13.1's "no PR claims `Closes #63` without confirmation" hedge is **RESOLVED** — T22 must not reproduce it and must not write `Refs #63`. Deferred work is filed as three tracked GitHub issues by **T22**.                                                                                                                                                                                         |
| **MO-2** | **ONE PR, not the four in §13.2.**                | Design **PR A** (splitting `src/actions/completion.ts` into per-shell modules) is **NOT DONE**. `completion.ts` is edited **in place** (1678 lines today, and it will grow — accepted). **T19** must map every §9.6 reference to `completion/{index,bash,zsh,fish}.ts` onto the corresponding section of the single file and create **no** files under `src/actions/completion/`. The split is filed as follow-up issue (b) by T22. Design PRs **B**, **C**, **D** all land together on this branch. |

---

## 1. Execution model

### 1.1 Shared tree, no isolation

Every implementer subagent edits **the same working tree** at the worktree path above. There is **no per-agent worktree, no branch per task, and no merge step.** Consequences, which are contractual:

- **Within a batch, no two tasks may write the same file.** The Master File-Ownership Table (§3) is the conflict-prevention contract: every written file appears exactly once, bound to exactly one task id.
- A file that genuinely needs edits from more than one concern is assigned to a **single owning task** wherever achievable. Where it cannot be, the touching tasks are placed in **different batches** and listed in §4.
- **Explicit spec ownership.** §3 lists every spec file with an explicit **`write` / `reserved`** label. `write` means the task is required to change it. `reserved` means the task owns it so that a needed fix has an unambiguous owner, but no change is expected. There is no "implicit" ownership in this plan; a spec that appears in no row is frozen.
- **Unowned-and-frozen files.** These appear in no task's write set and are pinned by `doneWhen` assertions: everything under `src/mcp/**`, `src/testing/cli-harness.ts`, `src/testing/mock-docker.ts`, `src/lib/exit-codes.ts`, `src/lib/docker.ts`, `src/lib/fuzzy-match.ts`, `src/lib/hardening-rules.ts`, `src/lib/interactive.tsx`, `src/commands/state.spec.ts`.

### 1.2 THE CARDINAL RULE FOR EVERY AGENT

> **Never edit a file you do not own. If a gate fails because of a sibling's in-flight file, REPORT AND WAIT — do not "fix" it, do not work around it, do not stage it.**

This rule appears in every task brief. It exists because in a shared tree with no isolation and no merge step, one cross-boundary edit is a silent lost write.

### 1.3 Barriers

Batches run with a **hard barrier** between them. All tasks in batch _N_ must reach their `doneWhen` before any task in batch _N+1_ starts. The layering rule is: **an earlier batch must produce every type and module a later batch imports**, otherwise every later agent fails `tsc --noEmit` and cannot self-verify.

Four **deliberate dependency inversions** exist purely to remove same-batch import coupling. Each is restated inside the affected task brief:

1. **T05** and **T06** must not import T04's `tag-path.ts` / `tag-pattern.ts` (all three are batch 2).
2. **T09**'s `selector.spec.ts` builds its `TagIndex` fixture as a literal instead of calling T08's `buildTagIndex` (both batch 3).
3. **T10**'s inference engine takes `index: TagIndex` as a **parameter** instead of importing T08's `tag-index.ts` (both batch 3).
4. **T12** and **T13** import tag modules by **direct path**, never through T11's same-batch `lib/tags/index.ts` barrel (all three are batch 4).

### 1.4 EXPECTED-RED WINDOW — `src/actions/completion.spec.ts` (read this before you panic)

`src/actions/completion.spec.ts` holds **seven exact set-equality parity assertions** that compare each command's live Commander-derived option set against the hand-maintained completion script. **Verified by experiment in this tree** (change made, test run, tree restored): adding a single `--tag` option to `src/commands/backup.ts` makes `completion.spec.ts:438` fail with `expected [ 'all', 'compose', …(7) ] to deeply equal [ 'all', 'compose', …(8) ]`.

| assertion            | line   | goes red in | broken by                     |
| -------------------- | ------ | ----------- | ----------------------------- |
| backup create parity | `:438` | **B6**      | T15 (`commands/backup.ts`)    |
| reconcile parity     | `:529` | **B6**      | T18 (`commands/reconcile.ts`) |
| harden parity        | `:602` | **B6**      | T18 (`commands/harden.ts`)    |
| import parity        | `:621` | **B6**      | T18 (`commands/import.ts`)    |
| deploy parity        | `:558` | **B7**      | T17 (`cli.ts`)                |
| rebuild parity       | `:562` | **B7**      | T17 (`cli.ts`)                |
| plan parity          | `:581` | **B7**      | T17 (`cli.ts`)                |

**This is planned, not a regression.** `completion.spec.ts` is **T19-owned and T19-repaired in batch 8**. Therefore:

- **The B6 and B7 barrier gates exclude it:** `npx vitest run src/actions src/commands --exclude '**/completion.spec.ts'` (verified working in this tree — `vitest run src/actions --exclude '**/completion.spec.ts'` → `25 passed / 325 tests`).
- **T15, T17 and T18 must NOT attempt to patch `completion.ts` or `completion.spec.ts`.** They do not own them.
- **T19 is handed the table above up front** so it knows exactly which seven failures it is expected to clear.
- The **B8 full-suite gate is the sole reconciliation point.**

### 1.5 Absolute-path gate rule (non-negotiable)

The main checkout at `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps` sits at **the same HEAD**. Any relative-path or `cd`-less verification command **passes vacuously against the wrong tree**. Therefore:

> Every verification command in this plan is prefixed with an absolute `cd`. Agents must not shorten them.

Shorthand used below: `WT=/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-feat-63-tagging`. **Agents must expand `$WT` to the literal path.**

Runtime hygiene, applied to every test invocation: `umask 022 && env -u FORCE_COLOR` (the agent shell sets `FORCE_COLOR`, which fails two rf-common logger tests and blocks `git push`; `umask 002` fails a filesystem permission test).

**Watch-mode trap.** At the repo **root**, `npm test` → `npm run test:run` → `bash scripts/test-run.sh`, which is safe. The hazard is **`npm test --workspace packages/rfapps-cli`** (the package `test` script is bare `vitest`) and bare **`npx vitest`** — both are watch mode and hang. Always use `npx vitest run …` or `npm run test:coverage --workspace packages/rfapps-cli`.

**`grep -c` exit-code trap.** `grep -c <pat> <file>` **exits 1** when the count is 0. Every "must not appear" assertion in this plan is therefore written as `! grep -q <pat> <file>`, never `grep -c … returns 0`.

### 1.6 The shared typecheck is concurrency-sensitive

Every per-task gate runs the package-wide `npm run typecheck --workspace packages/rfapps-cli`, and 2–4 agents run it concurrently against the same tree. A sibling's half-written file will make it fail for a reason you cannot diagnose or fix.

**Discipline (in every brief):** run the typecheck. If **all** reported errors are in files you own, fix them. If **any** error is in a file you do not own, wait ~60 s and re-run; if it persists, **report the blocking file and its owning task id and stop.** The authoritative typecheck is the **barrier** gate in §5.2, which runs only after every task in the batch is done.

### 1.7 Repo-wide compiler traps that apply to EVERY code task

`packages/rfapps-cli/tsconfig.json` sets, in addition to `strict`:

| Flag                                       | What it breaks                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `noUncheckedIndexedAccess: true`           | `arr[i]` is `T \| undefined`. A naive DP `cur[j] = prev[j] \|\| cur[j-1]` yields `TS2322`. Use `?? false` or local `const` bindings. |
| `verbatimModuleSyntax: true`               | A type-only import written as a value import **fails the build**. Use `import type { … }` for every type-only symbol.                |
| `noPropertyAccessFromIndexSignature: true` | `labels.someKey` on a `Record<string, …>` **fails**. Use `labels["some.key"]`. Directly relevant to T06/T10's compose-label reading. |
| `isolatedModules: true`                    | Re-exported types need `export type { … }`.                                                                                          |
| ESM / NodeNext                             | **Every** intra-package import needs a `.js` extension, even for `.ts` sources.                                                      |

`any` is forbidden repo-wide. Vitest specs must live under `packages/rfapps-cli/src/` — the include glob is `["src/**/*.spec.ts", "src/**/*.test.ts"]`, so a spec under `packages/rfapps-cli/test/` **never runs**. Use `vi.clearAllMocks()`, never `resetAllMocks`.

### 1.8 Batch overview

| Batch   | Tasks              | Theme                                                                                                      | Barrier gate                                                                          |
| ------- | ------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **B1**  | T01, T02, T03      | Leaf layer — types, error class, Commander helper.                                                         | typecheck + touched specs                                                             |
| **B2**  | T04, T05, T06, T07 | Pure grammar, fuzzy helper, rule catalog, config plumbing.                                                 | typecheck + new specs                                                                 |
| **B3**  | T08, T09, T10      | The three grammar consumers: index, selector, inference engine.                                            | typecheck + `src/lib`                                                                 |
| **B4**  | T11, T12, T13      | Barrels + warning validation, the read-only `tag` surface + its two action specs, the resolver chokepoint. | typecheck + `src/lib` + `src/commands` + `src/actions/tag*.spec.ts`                   |
| **B5**  | T14, T16           | Action-layer propagation (no flag declared yet — completion stays GREEN).                                  | typecheck + `src/actions` (full, incl. completion)                                    |
| **B6**  | T15, T18           | Flag declaration on the 10 dedicated registrars + DI seams + conflict lists.                               | typecheck + `src/actions src/commands --exclude completion.spec.ts` + `--help` smokes |
| **B7**  | T17                | `cli.ts` — 11 inline flag declarations, registrar, preAction, selector site 3. **Alone in its batch.**     | typecheck + `--exclude completion.spec.ts` + `--help` smokes                          |
| **B8**  | T19, T20, T24      | Shell completion repair + the two CLI-spawning spec suites (flag surface now frozen).                      | **full package suite, no exclusions**                                                 |
| **B9**  | T21, T22           | Documentation + repo deliverables + design.md formatting + three follow-up issues.                         | `format:check`, `lint:md`                                                             |
| **B10** | T23                | Write-light full CI-parity verification gate, alone in its batch.                                          | all gates                                                                             |

---

## 2. Batch-by-batch task list

---

### BATCH 1 — Leaf layer

_Three tasks that import nothing new. T01 mints every tag type and fans `tag?: string[]` into `ServiceTargetOptions`, unblocking every later task's typecheck. T02's error class is dependency-free by repo convention. T03's helper depends only on `commander`. No task in this batch reads another's output._

---

#### T01 — Tag types + `ServiceTargetOptions` / `RfappsConfig` fan-out + types barrel

**Owned files:**

| file                                            | mode                                                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfapps-cli/src/types/tags.ts` (new)   | write                                                                                                                        |
| `packages/rfapps-cli/src/types/options.ts`      | write                                                                                                                        |
| `packages/rfapps-cli/src/types/config.ts`       | write                                                                                                                        |
| `packages/rfapps-cli/src/types/index.ts`        | write                                                                                                                        |
| `packages/rfapps-cli/src/types/options.spec.ts` | reserved (verified: tests only `getEnvToolExecConfig`; **no `ServiceTargetOptions` shape assertion** — leave byte-identical) |

**Read-only context:** `packages/rfapps-cli/src/types/{audit,doctor,hardening}.ts` (verify they extend `ServiceTargetOptions`), `packages/rfapps-cli/src/mcp/schema.ts` (verify, do not edit).

**Design sections:** §4.1, §4.3, §4.4, §5.2, §9.2, §9.7

**Brief.**

Create `packages/rfapps-cli/src/types/tags.ts` transcribing design §4.1 **exactly as written**: the `TAGS_SCHEMA_VERSION = "tags.v1" as const` value; the three numeric limit consts (`TAG_MAX_DEPTH = 8`, `TAG_MAX_SEGMENT_LENGTH = 40`, `TAG_MAX_LENGTH = 128`); and **all 14 named types**: the branded nominal `TagPath`, plus `TagConfig`, `TagPatternElement`, `TagPattern`, `TagTerm`, `TagIndex`, `TagInferenceRuleId`, `TagInferenceConfidence`, `TagProposal`, `TagSuggestResult`, `TagListEntry`, `TagListResult`, `TagShowEntry`, `TagShowResult`. **Preserve every `readonly` modifier and every `Readonly<…>` / `ReadonlyMap` / `ReadonlySet` wrapper** — six downstream modules are written against these exact shapes. Add a file-level doc comment stating that **only `normalizeTag()` may mint a `TagPath`.**

MODIFY `src/types/options.ts`: add `tag?: string[];` to `ServiceTargetOptions` (currently ~`:48-57`, between `group?` and `noSidecars`) with the §4.3 JSDoc verbatim — one array element per `--tag` occurrence; commas OR within an element; AND across elements; `undefined` means resolution is **structurally** unchanged; **NEVER defaulted to `[]`**. This one edit fans out to `PullOptions`, `BuildOptions`, `DeployOptions`, `StopOptions`, `RebuildOptions`, `DeleteOptions`, `PruneOptions`, `StatusOptions`, `HealthOptions` (same file) plus `AuditOptions` (`types/audit.ts`), `DoctorOptions` (`types/doctor.ts`), `HardenOptions` (`types/hardening.ts`). **Read those three files to confirm they extend `ServiceTargetOptions`; do NOT edit them.**

MODIFY `src/types/config.ts`: add `tags?: TagConfig;` to `RfappsConfig` (after `harden?: HardenConfig;`) and `tags: Partial<TagConfig>;` to `PartialRfappsConfig`. Add `import type { TagConfig } from "./tags.js";`.

MODIFY `src/types/index.ts`: re-export `./tags.js` following the file's **existing** convention — read the neighbouring re-export lines and match them (grouped `export type { … } from "./x.js";` blocks, so the four consts need a separate value `export { … } from "./tags.js";`). Do not invent a new style. Add the module to the header doc-comment category list.

**Traps.**

1. `tag` is **optional everywhere** — never required, never defaulted.
2. **Do NOT touch anything under `src/mcp/`.** `McpTargetArgs`, `targetArgShape`, `statusTargetArgShape` and every `*InputSchema` must remain free of a `tag` key (§9.7). `schemaObject` is `additionalProperties: false` and iterates `Object.keys(input)`, so a `{ tag: undefined }` key throws `Unexpected properties at $: tag` at MCP runtime while typechecking clean.
3. **Do NOT add a `tags` field to `ServiceStatus` or `ServiceChange`** — both are MCP-surfaced and anchored by `_typeCheck` at `src/mcp/schema.ts`.
4. `verbatimModuleSyntax`: type-only imports must use `import type`.
5. §1.2 cardinal rule; §1.6 typecheck discipline.

**doneWhen.**

- `cd $WT && npm run typecheck --workspace packages/rfapps-cli` exits 0
- `packages/rfapps-cli/src/types/tags.ts` exports **all 4 consts and all 14 named types** from §4.1
- `cd $WT && git status --short` lists **no** file under `packages/rfapps-cli/src/mcp/` and **not** `packages/rfapps-cli/src/types/options.spec.ts`
- `cd $WT && grep -c 'tag?: string\[\]' packages/rfapps-cli/src/types/options.ts` returns exactly `1`

---

#### T02 — `TagSelectorEmptyError` class, formatter registration, and their specs

**Owned files:**

| file                                                                | mode                                                                                                                                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfapps-cli/src/lib/errors.ts`                             | write                                                                                                                                                             |
| `packages/rfapps-cli/src/lib/error-formatters.ts`                   | write                                                                                                                                                             |
| `packages/rfapps-cli/src/lib/errors.spec.ts`                        | write                                                                                                                                                             |
| `packages/rfapps-cli/src/lib/error-formatters.spec.ts`              | write                                                                                                                                                             |
| `packages/rfapps-cli/src/lib/error-formatters-registration.spec.ts` | reserved (verified: counts registrations self-relatively with `toBeGreaterThan(0)` + `toHaveBeenCalledTimes(firstCount)`, so adding one formatter keeps it green) |

**Read-only context:** `packages/rfapps-cli/src/lib/exit-codes.ts` (frozen).

**Design sections:** §4.5, §9.5, §6.6, §11

**Brief.**

Add **one** new error class `TagSelectorEmptyError` to `src/lib/errors.ts` (**verified: exactly 16 exported classes today**, ending with `ParallelExecutionError`), transcribing design §4.5. It **`extends Error`** (NOT `InvalidArgumentError`). Message: `` `Tag selector matched no services: ${patterns.join(", ")}` ``. `this.name = "TagSelectorEmptyError"` as a **string literal**. All context fields `readonly`. The file is dependency-free — do **not** import from actions, lib, or external packages.

Constructor signature:

```ts
constructor(
  patterns: string[],
  baseSelectors: string[],
  knownTags: string[],
  suggestion?: string,
  unresolvedServices: readonly string[] = [],
)
```

The first four parameters and their assignment must match §4.5 byte-for-byte, including `if (suggestion !== undefined) this.suggestion = suggestion;`.

**The fifth parameter is a documented completion of the design, resolved by this plan.** §4.5 lists only four fields, but §7.2 P4 and §9.5 require the formatter to name stale `tags.mapping` entries. Store it as `readonly unresolvedServices: readonly string[]` defaulting to `[]`, and add a source comment saying the design gap was closed here. The default preserves the §7.4 four-argument call site verbatim.

Register a formatter inside `registerRfappsErrorFormatters()` in `src/lib/error-formatters.ts` with `exitCode: ExitCode.UsageError`. Import the class at the top alongside the existing ones. **Numbering (verified):** the file has 16 numbered registrations running `// 1.` … `// 15.` **plus a `// 9b. GenerationNotFoundError`**. Append yours as **`// 16. TagSelectorEmptyError - Tag selector matched no services`** — 16 is the next unused number. Produce the two message shapes from §9.5:

- **Default:** the message line; then a `The selector also included: <baseSelectors joined>` line when `baseSelectors.length > 0`; then `--tag narrows the selection; it does not widen it.`; and suggestions `Did you mean '<suggestion>'?` (only when set), `Run 'rfapps tag list' to see all <knownTags.length> known tags`, `Drop <baseSelectors> to search all tagged services` (only when non-empty), and finally `Run with --debug for more details`.
- **When `unresolvedServices.length > 0`:** the `'tags.mapping' assigns this tag to services that are absent from compose.yml:` block naming them, with suggestions `Remove the stale entries from tags.mapping in rfapps.config.yaml`, `Run 'rfapps validate' to see every stale tag reference`, and `Run with --debug for more details`.

Add **one** case to `src/lib/errors.spec.ts` (construction, `name`, `instanceof`, readonly fields including the `unresolvedServices` default) and **one** to `src/lib/error-formatters.spec.ts` (formatted message + suggestions + `ExitCode.UsageError`).

**Traps.**

1. **Registration order is NOT load-bearing** — §13.17 corrects the opposite claim. All existing formatters are `instanceof`-exact with no catch-all and this class extends `Error`. Append anywhere inside the registrar; **do not reorder existing registrations.**
2. Every `getSuggestions` array **must end with** `"Run with --debug for more details"` — repo convention across all formatters.
3. `registerRfappsErrorFormatters()` is **already idempotent** (module-level `formattersRegistered` boolean). Still call it in `beforeAll`, never `beforeEach`, matching the existing specs.
4. **Do NOT add any other new error class.** Tag _syntax_ errors reuse `InvalidArgumentError`; config-side errors reuse `ConfigValidationError`.
5. **Do NOT add a `resolveTagExitCode` / `setTagExitCode` pair to `src/lib/exit-codes.ts`** (§6.6). That file must stay unmodified.
6. §1.2 cardinal rule; §1.6 typecheck discipline.

**doneWhen.**

- `cd $WT && npm run typecheck --workspace packages/rfapps-cli` exits 0
- `cd $WT/packages/rfapps-cli && umask 022 && env -u FORCE_COLOR npx vitest run src/lib/errors.spec.ts src/lib/error-formatters.spec.ts src/lib/error-formatters-registration.spec.ts` passes with **no pre-existing test removed**
- `cd $WT && git status --short packages/rfapps-cli/src/lib/exit-codes.ts` is empty
- `cd $WT && grep -c 'export class' packages/rfapps-cli/src/lib/errors.ts` returns `17`

---

#### T03 — Parameterized `addServiceTargetOptions` Commander helper

**Owned files:** `packages/rfapps-cli/src/lib/command-options.ts` (new) — write

**Read-only context:** `packages/rfapps-cli/src/cli.ts:356-378` (the `status` and `health` option blocks — copy the description strings from here), `packages/rfapps-cli/src/commands/audit.ts:7-10`.

**Design sections:** §6.2, §9.1

**Brief.**

Create `packages/rfapps-cli/src/lib/command-options.ts` (~45 lines) exporting:

```ts
export function addServiceTargetOptions(command: Command, opts?: { group?: boolean; sidecars?: boolean }): Command;
```

It declares, **in this order**: `-s, --service <name>` (`"Target a specific service"`), `--services <names>` (`"Target multiple services (comma-separated)"`), then `-g, --group <name>` (`"Target a service group"`) **only when `opts?.group !== false`**, then `--tag <pattern>` **always**, then `--no-sidecars` (`"Disable automatic sidecar linking"`) **only when `opts?.sidecars !== false`**. The description strings above are **verified byte-exact** against `cli.ts` and all six dedicated registrars — match them so the shell-completion parity extractors keep matching. Return `command` for chaining.

**Emitted long-option order is therefore `--service, --services, --group, --tag, --no-sidecars`.** This exact position is pinned by `src/commands/reconcile.spec.ts:42` (T18 updates that array to match).

The `--tag` declaration must be exactly:

```ts
.option(
  "--tag <pattern>",
  "Narrow targets by hierarchical tag pattern (repeatable)",
  (value: string, previous: string[] | undefined) => [...(previous ?? []), value],
)
```

Import `Command` as `import type { Command } from "commander";`.

**Traps — all four are load-bearing.**

1. **NO `[]` DEFAULT.** Do not pass a fourth argument to `.option()`. `commands/update.ts:23-30` and `commands/backup.ts:73-77` build conflict lists with `options.X === undefined ? undefined : "--X"`; with an `[]` default `options.tag` would never be `undefined`, so `rfapps update --from-plan <path>` would throw on **every** invocation and `rfapps backup --all` would **always** report a selector conflict.
2. **NEVER an argParser that throws.** Commander v14 calls `process.exit(1)` when an argParser throws, **before** `.action()` runs, bypassing `handleCliError`, the registered formatters, and the exit-code contract. The collector above cannot throw. All `--tag` pattern parsing/validation happens later in the `cli.ts` preAction hook or in `applyTagAxis` — never here.
3. The helper is **parameterized** because `status` (`cli.ts:356-368`) declares only `-s`/`--services` — **verified: it has no `-g`, no `--no-sidecars`, and no `-p/--profile`.** Blanket application would grant it flags it structurally cannot honor.
4. **Commander THROWS on a duplicate flag.** Verified in this tree: declaring `-s, --service` twice raises `Cannot add option '-s, --service <n>' … due to conflicting flag '--service'` at registration time, which kills every `rfapps` invocation. Document this in the helper's doc comment so callers know they must **replace** the existing declarations, not append to them.

Long-only: **no `-t` short form.**

**doneWhen.**

- `cd $WT && npm run typecheck --workspace packages/rfapps-cli` exits 0
- `cd $WT && ! grep -q 'throw' packages/rfapps-cli/src/lib/command-options.ts`
- `cd $WT && ! grep -q '"-t' packages/rfapps-cli/src/lib/command-options.ts`
- The `--tag` `.option()` call has exactly three arguments (no default value)
- The doc comment states the replace-don't-append rule and the Commander duplicate-flag throw

---

### BATCH 2 — Pure logic + config plumbing

_All four depend only on B1 types. T04 owns the grammar pair (tag-pattern reuses tag-path's segment validator, so they must share an owner). T05 and T06 are deliberately written with **no** import of T04's files. T07 lands the config-merge branches and the layer-path helper that T08 and T11 both need._

---

#### T04 — Tag path normalization + pattern parser + DP matcher (with specs)

**Owned files (all write):**

- `packages/rfapps-cli/src/lib/tags/tag-path.ts` (new, ~140 LOC)
- `packages/rfapps-cli/src/lib/tags/tag-pattern.ts` (new, ~150 LOC)
- `packages/rfapps-cli/src/lib/tags/tag-path.spec.ts` (new)
- `packages/rfapps-cli/src/lib/tags/tag-pattern.spec.ts` (new)

_(This task creates the new `packages/rfapps-cli/src/lib/tags/` directory.)_

**Read-only context:** `packages/rfapps-cli/src/types/tags.ts` (T01), `packages/rfapps-cli/src/lib/errors.ts` (for `InvalidArgumentError` / `ConfigValidationError` signatures).

**Design sections:** §3.1–§3.7, §11

**Brief.**

**`tag-path.ts`** — export `normalizeTag(input, …): TagPath`, `tagAncestors(tag: TagPath): readonly TagPath[]`, `compareTags(a, b): number`, and an exported segment-charset validator the pattern parser reuses. Implement §3.2 in **exactly this order**:

1. Trim surrounding whitespace.
2. `toLowerCase()`.
3. Strip **at most one** leading `/` and **at most one** trailing `/`.
4. Split on `/` and **throw** on any empty segment (so `a//b` and a doubled leading/trailing slash are rejected — a doubled slash has no defensible canonical reading).
5. Validate each segment against `^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$` (§3.1) and throw.
6. Validate depth ≤ `TAG_MAX_DEPTH` (8), each segment ≤ `TAG_MAX_SEGMENT_LENGTH` (40), total ≤ `TAG_MAX_LENGTH` (128) and throw.
7. Return `segments.join("/")` cast to `TagPath`.

Normalization must be **idempotent**. **Throw sites differ by caller:** CLI input throws `InvalidArgumentError("--tag", input, reason)`; config input throws `ConfigValidationError("tags.mapping", source, reason)`. Expose this via a parameter or overload so `tag-index.ts` (T08) can select the config flavour and pass the source path.

`tagAncestors("a/b/c")` returns **exactly** `["a", "a/b", "a/b/c"]`; `tagAncestors("a")` returns **exactly** `["a"]` (§3.3).

**`tag-pattern.ts`** — export `parseTagPattern(source: string): TagPattern`, `parseTagTerm(source: string): TagTerm` (splits one `--tag` flag value on commas; positive patterns → `include`, leading-`!` patterns → `exclude`), `tagMatches(pattern: TagPattern, tag: TagPath): boolean`, and `serviceMatches(pattern: TagPattern, effective: ReadonlySet<TagPath>): boolean`.

Grammar per §3.4: an element is a whole literal segment, `*` (exactly one segment, never crosses `/`), or `**` (zero or more segments, crosses `/`). Multiple `**` per pattern are allowed. A leading `!` negates the whole pattern.

Implement the matcher as the anchored DP in §3.5:

```
M[|P|][|T|] = true ; M[|P|][j<|T|] = false
P[i]="**"  -> M[i][j] = M[i+1][j] || (j < |T| && M[i][j+1])
P[i]="*"   -> M[i][j] = j < |T| && M[i+1][j+1]
P[i]=lit L -> M[i][j] = j < |T| && T[j] === L && M[i+1][j+1]
```

`tagMatches = M[0][0]`; `serviceMatches(P, s) = ∃ t ∈ E(s) : tagMatches(P, t)`. `|P|` and `|T|` are ≤ 8, so the DP is ≤ 81 cells — no memoization, no backtracking.

**Rejections, all with `InvalidArgumentError("--tag", value, reason)`:**

- **Trailing `/*` is REJECTED** (§3.7). The reason/suggestions must name the fix: `trailing '/*' is not supported`, suggesting `Use 'infrastructure' to select the whole subtree` and `Use 'infrastructure/**' for the same thing, written explicitly`. **Interior `*` (`\*/core/**`, `media/\*/tv`) stays fully supported\*\* — only the trailing position is rejected.
- Partial-segment wildcards `net*`, `*working`, `a**b`, and `?` are rejected. A wildcard occupies a **whole** element.
- Patterns are case-insensitive: lowercase literal segments before comparing.

**Do NOT add `picomatch` / `minimatch`** — their `*` crosses `/`, and they carry brace expansion, character classes, and dotfile rules this grammar forbids.

**Mandatory typing trap (§3.5).** `noUncheckedIndexedAccess: true`. A naive `cur[j] = prev[j] || cur[j-1]` produces `TS2322: Type 'boolean | undefined' is not assignable to type 'boolean'`. Write the DP with explicit `?? false` coalescing or local `const` bindings, and run the typecheck gate before finishing.

**Specs.** `tag-pattern.spec.ts` encodes the §3.6 table **verbatim and table-driven** using the exact §3.6 fixture (`traefik: [infrastructure/core/networking]`, `homarr: [infrastructure]`, `plex: [media/streaming, hardware/gpu]`, `sabnzbd: [downloads/usenet]`) with effective sets computed via `tagAncestors`. Cover **every row**: bare `infrastructure`; `infrastructure/**` identical to it; `infrastructure/*` **REJECTED** with the corrective suggestion; `infrastructure/core`; `infrastructure/core/networking`; `infrastructure/core/**`; `*/core/**`; `**/networking`; `*`; `**`; `media`; `hardware/gpu`; `MEDIA/Streaming` (case-insensitive); `!media/**`; `media/**,hardware/**` (OR within one flag); multiple `**`; a negation-only term selecting untagged services; and an untagged service matching **nothing**, including `**`.

`tag-path.spec.ts` covers: idempotent normalization; case folding; single leading/trailing slash stripped; `a//b` rejected; depth/segment/total length limits; and `tagAncestors` exact output including the depth-1 no-op.

**Traps.** §1.2 cardinal rule; §1.6 typecheck discipline.

**doneWhen.**

- `cd $WT && npm run typecheck --workspace packages/rfapps-cli` exits 0 _(this is the `noUncheckedIndexedAccess` gate)_
- `cd $WT/packages/rfapps-cli && umask 022 && env -u FORCE_COLOR npx vitest run src/lib/tags/tag-path.spec.ts src/lib/tags/tag-pattern.spec.ts` passes
- Every row of design §3.6 has a corresponding assertion in `tag-pattern.spec.ts`
- `infrastructure/*` throws `InvalidArgumentError` and `*/core/**` matches `traefik`
- `cd $WT && ! grep -qE 'picomatch|minimatch' packages/rfapps-cli/src/lib/tags/tag-pattern.ts`

---

#### T05 — Segment-aware `findClosestTag` fuzzy suggestion helper

**Owned files:** `packages/rfapps-cli/src/lib/tags/tag-suggestions.ts` (new, ~60 LOC) — write

**Read-only context:** `packages/rfapps-cli/src/lib/fuzzy-match.ts` (verified: `findClosestMatch(query, candidates, minScore = 0.4)` at `:52`; `computeSimilarity` exported at `:55`).

**Design sections:** §3.9

**Brief.**

Create `packages/rfapps-cli/src/lib/tags/tag-suggestions.ts` exporting:

```ts
export function findClosestTag(pattern: string, knownTags: readonly TagPath[]): string | undefined;
```

The shared `findClosestMatch` is **path-unaware**: `computeSimilarity("networking", "infrastructure/core/networking") ≈ 0.34`, below its `minScore = 0.4` default, so it returns nothing useful for hierarchical tags. Implement §3.9 exactly:

1. Extract the pattern's **last literal segment** (skip `*`, `**`, and a leading `!`). If there is none, return `undefined`.
2. For each known tag, compute `max(computeSimilarity(lastLiteral, seg))` over that tag's `/`-split segments.
3. Compute `computeSimilarity(fullPattern, fullTag)`.
4. Take the max of (2) and (3); return the best-scoring tag **above `0.5`**, else `undefined`.

Import `computeSimilarity` from `../fuzzy-match.js` and `import type { TagPath } from "../../types/tags.js";`.

**Traps.**

1. **Do NOT change `findClosestMatch`'s `minScore = 0.4` default** and **do not edit `src/lib/fuzzy-match.ts` at all** — `fuzzy-match.spec.ts` pins it and service-name suggestions depend on it.
2. **Do NOT import `./tag-path.js` or `./tag-pattern.js`** — those files are being written concurrently by T04 in this same batch. Split on `/` and filter wildcard tokens with plain string checks inside this module.
3. The threshold here is `0.5`, deliberately different from the shared `0.4` default.
4. §1.2 cardinal rule; §1.6 typecheck discipline.

**doneWhen.**

- `cd $WT && npm run typecheck --workspace packages/rfapps-cli` exits 0
- `cd $WT && git status --short packages/rfapps-cli/src/lib/fuzzy-match.ts` is empty
- `cd $WT && ! grep -qE 'tag-path\.js|tag-pattern\.js' packages/rfapps-cli/src/lib/tags/tag-suggestions.ts`

---

#### T06 — Seven-rule tag inference catalog + compose structural view types

**Owned files:** `packages/rfapps-cli/src/lib/tags/tag-inference-rules.ts` (new, ~140 LOC) — write

**Read-only context:** `packages/rfapps-cli/src/lib/hardening-rules.ts` (the structural model: `HARDEN_RULES` at `:78`, `HARDEN_RULE_IDS` at `:321`), `packages/rfapps-cli/src/lib/docker.ts` (`ComposeServiceConfig` — **frozen**), `packages/rfapps-cli/src/actions/harden.ts:244` (`HardenComposeConfig` cast precedent), `packages/rfapps-cli/src/types/config.ts`, `packages/rfapps-cli/src/types/tags.ts`.

**Design sections:** §8.2, §8.3, §8.4

**Brief.**

Create `packages/rfapps-cli/src/lib/tags/tag-inference-rules.ts`, modelled structurally on `lib/hardening-rules.ts` so rule ids are completable the same way.

Export:

- `interface TagInferenceRule { readonly id: TagInferenceRuleId; readonly description: string; readonly confidence: TagInferenceConfidence; readonly needsDocker: boolean; evaluate(ctx: TagInferenceContext): readonly string[] }` — `evaluate` returns **un-normalized** proposal strings.
- `interface TagInferenceContext` carrying at minimum: `service` (name), `config: RfappsConfig`, and `composeService?: TagInferenceComposeService`.
- The **local structural compose view** from §8.3, exported so T10's engine reuses it:

```ts
export interface TagInferenceComposeService {
  readonly image?: string;
  readonly labels?: Readonly<Record<string, string>> | readonly string[];
}
export interface TagInferenceComposeConfig {
  readonly services: Readonly<Record<string, TagInferenceComposeService>>;
}
```

- `TAG_INFERENCE_RULES: readonly TagInferenceRule[]` and `TAG_INFERENCE_RULE_IDS: readonly TagInferenceRuleId[]` (ids only, for `--rule` completion and `--list-rules`), mirroring `HARDEN_RULE_IDS = HARDEN_RULES.map((rule) => rule.id)`.
- A **label-reading helper handling both forms** (map and list). This repo uses map form in all 27 label-bearing services, but list form is legal Compose. **Non-string label values are real in this file** (`docktail.service.enable: true`, `docktail.service.port: 32400`); coerce them explicitly and **never blindly `String()`-split**.

The seven rules, per the §8.2 table:

| id                   | signal                                                                                       | proposal                                                                                                                                                                        | confidence | needsDocker                                    |
| -------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------- |
| `tag-infer-profile`  | `config.profiles.mapping[s]`                                                                 | `core`→`platform/core`, `infrastructure`→`platform/infrastructure`, `downloads`→`media/downloads`, `arr-stack`→`media/automation`, `media`→`media/streaming`, `photos`→`photos` | medium     | false                                          |
| `tag-infer-group`    | membership in `config.groups`                                                                | second segment from the group slug, e.g. `auth-stack`→`platform/identity`                                                                                                       | medium     | false                                          |
| `tag-infer-arr`      | name matches `/^(son\|rad\|lid\|read\|baz\|prowl)arr$/` OR image matches `linuxserver/.*arr` | `media/automation/arr`                                                                                                                                                          | high       | **false** (the name variant must work offline) |
| `tag-infer-database` | image basename ∈ {postgres, mariadb, mysql, mongo}                                           | `data/database`                                                                                                                                                                 | high       | true                                           |
| `tag-infer-cache`    | image basename ∈ {redis, valkey, memcached}                                                  | `data/cache`                                                                                                                                                                    | high       | true                                           |
| `tag-infer-ingress`  | a `traefik.enable` label is present OR image basename ∈ {traefik, nginx, caddy, haproxy}     | `network/ingress`                                                                                                                                                               | high       | true                                           |
| `tag-infer-tailnet`  | a `docktail.service.*` label is present                                                      | `network/tailnet`                                                                                                                                                               | high       | true                                           |

`needsDocker` drives §8.4 degraded mode: T10's engine skips `needsDocker` rules when `getComposeConfig` is unavailable.

**Traps.**

1. `ComposeServiceConfig` in `src/lib/docker.ts` has **no `labels` field and you must NOT add one** — widening it would change a type consumed by plan-generation fingerprinting. Use the local structural view above; the single `as unknown as TagInferenceComposeConfig` cast happens at T10's call boundary, not here.
2. **Do NOT extend `LINT_RULES` or `HARDEN_RULES`.** `tag-infer-*` ids must never collide with `LintRuleId`, `AuditRuleId`, or `HardenRuleId`.
3. **Do NOT import `./tag-path.js`** — T04 is writing it concurrently in this batch. Return raw strings; T10's engine normalizes.
4. This module reads **config and compose only** — never runtime state, never `docker stats` (that is issue #62).
5. `noPropertyAccessFromIndexSignature: true` — read labels as `labels["traefik.enable"]`, never `labels.traefik.enable`.
6. §1.2 cardinal rule; §1.6 typecheck discipline.

**doneWhen.**

- `cd $WT && npm run typecheck --workspace packages/rfapps-cli` exits 0
- `TAG_INFERENCE_RULE_IDS` has exactly the 7 ids declared in `TagInferenceRuleId` in `src/types/tags.ts`
- `cd $WT && git status --short packages/rfapps-cli/src/lib/docker.ts packages/rfapps-cli/src/lib/hardening-rules.ts` is empty
- The label helper has explicit branches for map form **and** list form
- `cd $WT && ! grep -q 'tag-path.js' packages/rfapps-cli/src/lib/tags/tag-inference-rules.ts`

---

#### T07 — Config merge / `partialToFull` `tags` branches + config layer path helper

**Owned files:**

| file                                         | mode                                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `packages/rfapps-cli/src/lib/config.ts`      | write                                                                                                |
| `packages/rfapps-cli/src/lib/config.test.ts` | write _(note the `.test.ts` suffix — the vitest include glob covers both `_.spec.ts`and`_.test.ts`)_ |

**Read-only context:** `packages/rfapps-cli/CLAUDE.md` (the documented 4-step config-section recipe), `packages/rfapps-cli/src/lib/config-helpers.spec.ts`, `packages/rfapps-cli/src/lib/config-missing.spec.ts`, `packages/rfapps-cli/src/testing/cli-harness.ts:54` (**frozen** — its `DEFAULT_FIXTURE_CONFIG_YAML` must keep satisfying only the four required sections).

**Design sections:** §5.2, §5.4, §9.2, §11, §13.1

**Brief.**

Wire the new optional `tags:` config section through `src/lib/config.ts`, modelled **byte-for-byte** on the existing `harden:` section.

1. In `mergeConfig` (the `:120-178` block, beside the `lint`/`scan`/`harden` branches) add:
   `tags: { mapping: override.tags?.mapping ?? base.tags?.mapping ?? {} },`
2. In `partialToFull` (the `:184-271` block, beside the `scan`/`harden` branches) add:
   `tags: { mapping: partial.tags?.mapping ?? {} },`
3. Export a **new read-only helper**:

```ts
export async function listConfigLayerPaths(cwd?: string): Promise<string[]>;
```

It returns the **absolute** paths of every config layer file that **exists**, in precedence order **highest-first**. The real precedence, verified against `loadConfig` (`config.ts:438-500`), is:

| Rank        | Layer   | Discovery                                                                                               |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------- |
| 1 (highest) | local   | `findConfigFile(workingDir)` over `CONFIG_FILE_NAMES = [".rfapps.yaml", ".rfapps.yml", ".rfapps.json"]` |
| 2           | XDG     | `findConfigFile(join(homedir(), ".config", "rfapps"))`                                                  |
| 3           | home    | `findConfigFile(homedir())`                                                                             |
| 4 (lowest)  | project | `join(workingDir, "rfapps.config.yaml")` if it exists, else `getProjectConfigPath()`                    |

**Reuse the module-private `findConfigFile` / `fileExists` / `PROJECT_CONFIG_NAME` already in this file** rather than duplicating the precedence logic. The helper must **never throw** when a path is missing — it just omits it. It is required by T08's `tag-index.ts` (to report `TagIndex.source`) and by T11's `validateTagLayerOwnership`.

**Critical trap (§5.2).** `tags` **MUST NOT** join the four required-field throws at `config.ts:186-209` (`sidecars.mapping`, `groups`, `profiles.mapping`, `profiles.validProfiles`). Adding a fifth required section would break every existing config file **and** the default fixture at `src/testing/cli-harness.ts:54`. `tags` is **optional** and defaults to `{ mapping: {} }`. Verify the throw list still has exactly 4 entries when you finish.

**Other traps.**

- **No `RFAPPS_TAGS` env var.** Do not touch `loadConfigFromEnv` (`:320-406`) — it handles 9 scalars and has no map/array precedent.
- **No entry in `generateSampleConfig`** (`:604-646`) — it already omits `groups`, `lint`, `scan`, and `harden`. The commented-out template goes into the shipped `rfapps.config.yaml` instead (owned by **T22**).
- **Layering is WHOLESALE REPLACEMENT, not deep merge.** `mergeConfig` is one level deep for every collection; `tags.mapping` follows the same rule. Do **not** introduce the function's first deep merge.
- `applyCliOverrides` (`:523`) is a shallow `{...config}` spread, so `tags` survives it with **no edit** — leave it alone.
- `getStateDbPath`, `validateConfig`, `getDefaultConfigPath` need no change.
- **`config.ts` must not gain an import of `./validation.js`** — verified: it imports only node builtins, `yaml`, `@rfmedia/common`, `./errors.js`, `./db.js`, and `../types/index.js`. Keeping it that way is what makes T08's no-cycle design work.
- §1.2 cardinal rule; §1.6 typecheck discipline.

**Spec.** Add to `src/lib/config.test.ts` a case proving a `tags:` block in a **higher** layer **replaces** the base's wholesale (the documented footgun from §5.4). This is also the only coverage of any `mergeConfig` optional-section branch. Keep existing tests untouched.

**doneWhen.**

- `cd $WT && npm run typecheck --workspace packages/rfapps-cli` exits 0
- `cd $WT/packages/rfapps-cli && umask 022 && env -u FORCE_COLOR npx vitest run src/lib/config.test.ts src/lib/config-helpers.spec.ts src/lib/config-missing.spec.ts` passes, including the new wholesale-replacement case
- `cd $WT && grep -c "Missing required field" packages/rfapps-cli/src/lib/config.ts` returns `4`
- `listConfigLayerPaths` is exported; `loadConfigFromEnv`, `generateSampleConfig`, and `applyCliOverrides` are unmodified
- `cd $WT && ! grep -q 'from "./validation.js"' packages/rfapps-cli/src/lib/config.ts`
- `cd $WT && git status --short packages/rfapps-cli/src/testing/cli-harness.ts` is empty

---

### BATCH 3 — The three grammar consumers

_T08 builds the index; T09 unifies the selector predicates and computes the tag axis; T10 is the inference engine. **T10 takes `TagIndex` as a parameter rather than importing `buildTagIndex`**, and **T09's spec builds its `TagIndex` fixture literally** — those two inversions are what let all three run in parallel._

---

#### T08 — `buildTagIndex` / `getTagIndex` with ancestor closure and `unresolvedServices`

**Owned files (all write):**

- `packages/rfapps-cli/src/lib/tags/tag-index.ts` (new, ~150 LOC)
- `packages/rfapps-cli/src/lib/tags/tag-index.spec.ts` (new)

**Read-only context:** `packages/rfapps-cli/src/lib/tags/{tag-path,tag-suggestions}.ts` (T04/T05), `packages/rfapps-cli/src/lib/config.ts` (T07's `listConfigLayerPaths`), `packages/rfapps-cli/src/types/tags.ts`.

**Design sections:** §3.3, §3.9, §4.1, §5.1, §5.4, §7.2, §11

**Brief.**

Create `packages/rfapps-cli/src/lib/tags/tag-index.ts`, plus **re-export `findClosestTag` from `./tag-suggestions.js`** so callers have one import site (design §3.9 places `findClosestTag` on `tag-index.ts`'s public surface; the implementation lives in `tag-suggestions.ts` and you must **not** reimplement it).

**PLAN-MANDATED SIGNATURES — the compose universe is a PARAMETER, never fetched here.**

```ts
export interface TagNormalizationWarning {
  readonly service: string;
  readonly authored: string;
  readonly normalized: TagPath;
  readonly message: string;
}

/** Pure. No I/O. */
export function buildTagIndex(input: {
  readonly mapping: Readonly<Record<string, readonly string[]>>;
  readonly universe: readonly string[];
  readonly source: string;
}): { readonly index: TagIndex; readonly warnings: readonly TagNormalizationWarning[] };

/** Memoized wrapper. Resolves `source` via listConfigLayerPaths(). Still takes `universe`. */
export async function getTagIndex(
  config: RfappsConfig,
  composePath: string,
  universe: readonly string[],
): Promise<TagIndex>;
```

**This module MUST NOT import `../validation.js`.** T11 makes `src/lib/validation.ts` import `buildTagIndex` from here; if this module reached back for `parseComposeFile`, the result would be a circular ESM import between two modules one of which (`validation.ts:54 let composeCache`) holds mutable module-level cache state. Taking `universe` as a parameter removes the cycle entirely. Every caller already has the universe: T13's resolver and T16's status action both call `parseComposeFile` themselves; T11 already holds `composeServices`; T12's actions call `parseComposeFile` in the action layer.

`buildTagIndex` consumes the declared mapping (service → tag strings, **as authored**) plus the compose service universe, and produces the `TagIndex` from §4.1 with **every field populated**:

- `declared`: service → normalized `TagPath[]`.
- `effective`: service → ancestor-closed `ReadonlySet<TagPath>`, i.e. `E(s) = ⋃_{t ∈ D(s)} tagAncestors(t)` (§3.3). **All matching is against `E(s)`, never `D(s)`.**
- `byTag`: tag → services carrying it **effectively** (the inverse of `effective`, not of `declared`).
- `allTags`: every effective tag, **sorted**.
- `declaredTags`: only tags an operator actually wrote — no derived ancestors.
- `unresolvedServices`: services present in the mapping but **absent** from `universe`. This is P4 and it is load-bearing: it lets `TagSelectorEmptyError` say _"tags.mapping assigns this tag to services absent from compose.yml: plex-old"_ instead of a useless _"matched nothing"_.
- `source`: the **absolute** path of the config layer that won the `tags:` block, supplied by `getTagIndex` from `listConfigLayerPaths()` — take the **highest-precedence existing layer whose parsed YAML has a top-level `tags:` key**; fall back to the lowest-precedence (project) path when none does.

Normalization uses `normalizeTag` from `./tag-path.js` in its **config flavour**, so a malformed entry throws `ConfigValidationError("tags.mapping", source, reason)` — fail fast at the boundary (§3.2). Case-folding a config tag additionally produces a `TagNormalizationWarning` (e.g. `Tag 'Media/Streaming' for service 'plex' was normalized to 'media/streaming'`) **returned to the caller**; T11's `validateTagReferences` consumes it. **Do NOT log warnings from here.**

`getTagIndex` **memoizes** per `(config identity, composePath)` so a single command builds the index **at most once**. Use a `WeakMap<RfappsConfig, Map<string, TagIndex>>` or equivalent.

**Spec** (`tag-index.spec.ts`): ancestor closure builds `effective` correctly; `byTag` is the correct inverse; `unresolvedServices` is populated for a mapping entry absent from the universe; case-folding produces a `TagNormalizationWarning`; and `findClosestTag` returns a suggestion in the case where the shared `findClosestMatch` returns none (the ~0.34 `networking` vs `infrastructure/core/networking` case from §3.9). Covering this module only transitively through `selector.spec.ts` was a judge-flagged gap, so these must be **direct** tests. Assert the memoization with a spy or call counter.

**Traps.**

1. Storage is **config-only** — never read or write `compose.yml` labels, never touch the SQLite state DB, never write any file (§5.3).
2. Do **not** deep-merge across layers; the winning layer's `tags:` fully shadows lower layers (§5.4).
3. `noUncheckedIndexedAccess: true` — guard every index access.
4. `verbatimModuleSyntax` — `import type` for all type-only symbols.
5. §1.2 cardinal rule; §1.6 typecheck discipline.

**doneWhen.**

- `cd $WT && npm run typecheck --workspace packages/rfapps-cli` exits 0
- `cd $WT/packages/rfapps-cli && umask 022 && env -u FORCE_COLOR npx vitest run src/lib/tags/tag-index.spec.ts` passes
- All 7 `TagIndex` fields are populated by `buildTagIndex`
- `getTagIndex` called twice with the same `(config, composePath)` builds the index once (asserted)
- `cd $WT && ! grep -qE 'validation\.js|writeFile' packages/rfapps-cli/src/lib/tags/tag-index.ts`

---

#### T09 — `lib/selector.ts` — `SelectorFlags`, `hasExplicitSelector`, `applyTagAxis` (+ spec)

**Owned files (all write):**

- `packages/rfapps-cli/src/lib/selector.ts` (new, ~140 LOC)
- `packages/rfapps-cli/src/lib/selector.spec.ts` (new)

**Read-only context:** `packages/rfapps-cli/src/lib/interactive-selection.ts:99-104` (the 4 inline predicate lines being replaced), `packages/rfapps-cli/src/lib/interactive-check.ts:63-71`, `packages/rfapps-cli/src/cli.ts:260-263`, `packages/rfapps-cli/src/commands/backup.ts:73-77`, `packages/rfapps-cli/src/lib/tags/tag-pattern.ts` (T04).

**Design sections:** §4.2, §3.8, §7.1, §7.2, §11, §13.5

**Brief.**

Create `packages/rfapps-cli/src/lib/selector.ts` — **the** unification point that replaces four duplicated inline predicates plus two `selectorFlags` array literals, and the single extension point issue #62 will edit. Transcribe the §4.2 signatures exactly:

```ts
export interface SelectorFlags {
  readonly service?: string;
  readonly services?: string | readonly string[];
  readonly group?: string;
  readonly tag?: readonly string[];
}
export function hasServicesSelector(services: string | readonly string[] | undefined): boolean;
export function hasExplicitSelector(flags: SelectorFlags): boolean;
export function explicitSelectorFlagNames(flags: SelectorFlags): string[];
export function describeSelector(flags: SelectorFlags): string;
export type TagAxis =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly terms: readonly TagTerm[]; readonly matched: ReadonlySet<string> };
export function applyTagAxis(
  tagFlags: readonly string[] | undefined,
  index: TagIndex,
  universe: readonly string[],
): TagAxis;
```

**`services` accepts BOTH shapes on purpose (§13.5).** Commander declares `--services <names>` with **no argParser**, so raw `actionCommand.opts()` yields a **comma-joined string**, while typed option objects carry `string[]`. Two of the six call sites read raw Commander opts (`cli.ts` deploy `--staged` preflight, `commands/backup.ts`), so a `string[]`-only signature would either not typecheck or silently coerce. `hasServicesSelector` normalizes: **empty string AND empty array both mean ABSENT.**

**Documented behavior change:** `cli.ts` currently treats `--services ""` as a target (`!== undefined`); `hasServicesSelector` returns `false` for `""`. This is deliberate — `--services ""` splits to zero names, so treating it as a target is a latent bug that today suppresses the deploy `--staged` preflight for a selector resolving to nothing. **Pin it with a test.**

`explicitSelectorFlagNames` returns e.g. `["--group", "--tag"]` (for `--all` conflict checks and error messages). `describeSelector` returns e.g. `--group arr-stack, --tag "media/**"` (for `InvalidArgumentError` reasons).

**`applyTagAxis`** implements §3.8 + §7.1: return `{ kind: "absent" }` when `tagFlags` is `undefined` **OR** an empty array — this is the **structural** backward-compatibility guarantee (P1); callers MUST short-circuit on it. Otherwise, for each `--tag` occurrence _k_: parse with `parseTagTerm` from `./tags/tag-pattern.js`; `INC_k` = union over positive patterns of `{ s ∈ universe : serviceMatches(p, index.effective.get(s) ?? ∅) }`, but `INC_k = universe` when flag _k_ contains **only** negations; `EXC_k` = union over negated patterns; `T_k = INC_k \ EXC_k`. Then `matched = ⋂_k T_k`. **Preserve `universe` order** when materializing (P5).

**`applyTagAxis` THROWS `InvalidArgumentError` on a malformed pattern but NEVER throws on an empty result** — the empty-vs-error decision belongs to the caller (query surfaces tolerate empty; selector commands throw `TagSelectorEmptyError`). **Do not import or throw `TagSelectorEmptyError` from this file.**

Document in a comment the consequence of negation-only terms: `--tag "!media/**"` selects **untagged services too**, because `E(s) = ∅` makes every positive pattern false but also makes every negation vacuously non-excluding. It is **not** the complement of `--tag "**"`.

**Spec** (`selector.spec.ts`): `hasExplicitSelector` across all four axes and **both** `services` shapes (comma string AND array), with `""` and `[]` treated as absent; `explicitSelectorFlagNames` output; `applyTagAxis` returns `{kind:"absent"}` for `undefined` **and** for `[]`; AND-across-flags; OR-within-flag; negation.

**Construct the `TagIndex` fixture as a LITERAL** (`new Map` / `new Set`) rather than calling `buildTagIndex` — T08's `tag-index.ts` is being written concurrently in this same batch.

**Traps.**

1. Adding a new selector axis must mean editing **this** function and nothing else — keep the predicate exhaustive over `SelectorFlags`.
2. `noUncheckedIndexedAccess: true`.
3. No `any`; `.js` import extensions; `import type` for types.
4. §1.2 cardinal rule; §1.6 typecheck discipline.

**doneWhen.**

- `cd $WT && npm run typecheck --workspace packages/rfapps-cli` exits 0
- `cd $WT/packages/rfapps-cli && umask 022 && env -u FORCE_COLOR npx vitest run src/lib/selector.spec.ts` passes
- `applyTagAxis(undefined, …)` and `applyTagAxis([], …)` both return `kind:"absent"`
- `cd $WT && ! grep -q 'tag-index.js' packages/rfapps-cli/src/lib/selector.spec.ts`
- `cd $WT && ! grep -q 'TagSelectorEmptyError' packages/rfapps-cli/src/lib/selector.ts`

---

#### T10 — Tag inference engine, degraded mode, and YAML fragment renderer (+ spec)

**Owned files (all write):**

- `packages/rfapps-cli/src/lib/tags/tag-inference.ts` (new, ~150 LOC)
- `packages/rfapps-cli/src/lib/tags/tag-inference.spec.ts` (new)

**Read-only context:** `packages/rfapps-cli/src/lib/tags/{tag-inference-rules,tag-path}.ts` (T06/T04), `packages/rfapps-cli/src/lib/docker.ts:1098` (`getComposeConfig` — **frozen**), `packages/rfapps-cli/src/actions/harden.ts:244` (the `as unknown as` cast precedent), `packages/rfapps-cli/src/types/tags.ts`.

**Design sections:** §8.1–§8.5, §11

**Brief.**

Create `packages/rfapps-cli/src/lib/tags/tag-inference.ts` — the inference **engine**. The rule catalog and the compose structural-view types already exist in `./tag-inference-rules.ts`; **import them, do not redefine them.**

Export an engine function taking `(config: RfappsConfig, index: TagIndex, options)` and returning the `TagSuggestResult` from §4.1: `{ schemaVersion, proposals, unresolved, skippedRules, degraded, fragment, writtenTo? }`.

**Take `index: TagIndex` as a PARAMETER — do NOT import `buildTagIndex` / `getTagIndex` from `./tag-index.js`.** T08 is writing that module concurrently in this same batch; T12's action layer builds the index and passes it in. You need the index only to compute `TagProposal.alreadyPresent` (true when the service already carries this tag **or an ancestor**, checked against `index.effective`).

Behavior:

- Run each selected rule over each in-scope service, normalizing every returned string with `normalizeTag` from `./tag-path.js` in its **CLI flavour** (an inference rule emitting a malformed tag is a bug — let it throw).
- Group results per service into `TagProposal { service, tags, rules, confidence, alreadyPresent }`. Confidence is the **highest** of the contributing rules.
- **Default: only propose services WITHOUT an existing matching tag** (`alreadyPresent: false`), so `suggest` is **idempotent** under repeated runs. `--include-tagged` shows everything.
- **Degraded mode (§8.4):** `getComposeConfig` shells `docker compose config --format json`. If the Docker CLI is unavailable, **catch** it, degrade to the config-only rules (`tag-infer-profile`, `tag-infer-group`, and the **name variant** of `tag-infer-arr`), set `degraded: true`, and list the skipped ids in `skippedRules`. Fail-soft is correct here because the surface is purely advisory and mutates nothing.
- Cast the compose config **once** via `as unknown as TagInferenceComposeConfig`. **Do NOT add a `labels` field to `ComposeServiceConfig` in `src/lib/docker.ts`.**
- Render `fragment`: a copy-pasteable `tags:\n  mapping:\n    <service>:\n      - <tag>\n` YAML block with a generated header stating the fragment is a **PASTE SOURCE, not a loadable config layer** — pasting it into `.rfapps.yaml` rather than into the layer that owns `tags:` would **shadow** the base taxonomy (§5.4).

**The safety-critical guarantee: this module writes NOTHING to configuration, EVER, and performs NO file write at all.** The only file write in the whole `suggest` surface is T12's `--out <path>`, and that belongs to the **action**, not here. This module returns a string.

**Spec** (`tag-inference.spec.ts`) — exactly these four **engine** behaviors:

1. The engine writes **nothing** (assert no `fs.writeFile` / `writeFileSync` is called) under every mode: default, `--include-tagged`, `--rule` subset, degraded.
2. Degraded mode reports `degraded: true` and populates `skippedRules` when `getComposeConfig` rejects.
3. `tag-infer-ingress` fires on a `traefik.enable` label in **MAP** form.
4. `tag-infer-ingress` fires on the same label in **LIST** form.

Cases 3 and 4 cover the label-shape branch — the one place a real bug hides. Mock `getComposeConfig`. **Note (plan-corrected):** design §11 also lists _"`--out` with an existing file throws"_ under this spec, but `--out` is handled in `src/actions/tag-suggest.ts` and cannot be exercised from here. That case is assigned to **T12's `src/actions/tag-suggest.spec.ts`** instead.

**Traps.**

1. Never take the global state lock; never call `initializeDatabase()`.
2. Never read runtime state (`docker stats`, health) — that is issue #62.
3. `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`.
4. §1.2 cardinal rule; §1.6 typecheck discipline.

**doneWhen.**

- `cd $WT && npm run typecheck --workspace packages/rfapps-cli` exits 0
- `cd $WT/packages/rfapps-cli && umask 022 && env -u FORCE_COLOR npx vitest run src/lib/tags/tag-inference.spec.ts` passes with all four named cases
- `cd $WT && ! grep -qE 'tag-index\.js|writeFile' packages/rfapps-cli/src/lib/tags/tag-inference.ts`
- `cd $WT && git status --short packages/rfapps-cli/src/lib/docker.ts` is empty

---

### BATCH 4 — Barrels, the `tag` command surface, and the resolver chokepoint

_All three depend only on B1–B3. **T12 and T13 import tag modules by DIRECT path**, not through the `lib/tags/index.ts` barrel T11 writes in the same batch. T13 is the single highest-consequence edit in the feature and gets a whole task to itself._

---

#### T11 — `validateTagReferences` / `validateTagLayerOwnership` (warning-only) + lib barrels

**Owned files:**

| file                                                       | mode                                                              |
| ---------------------------------------------------------- | ----------------------------------------------------------------- |
| `packages/rfapps-cli/src/lib/validation.ts`                | write                                                             |
| `packages/rfapps-cli/src/lib/index.ts`                     | write                                                             |
| `packages/rfapps-cli/src/lib/tags/index.ts` (new, ~25 LOC) | write                                                             |
| `packages/rfapps-cli/src/lib/validation.spec.ts`           | reserved (no change expected; owned so a needed fix has an owner) |

**Read-only context:** `packages/rfapps-cli/src/actions/deploy.ts:392-406` (the `hasErrors()` abort), `packages/rfapps-cli/src/lib/config.ts` (T07's `listConfigLayerPaths`), all six `src/lib/tags/*.ts` modules.

**Design sections:** §5.4, §7.2, §9.2, §12

**Brief — two jobs.**

**A. `src/lib/validation.ts`.** Add `validateTagReferences` and `validateTagLayerOwnership` beside the existing `validateGroupReferences` (`:199-227`), and **call both** from `validateConfigAgainstCompose` (`:301-344`, already `async`).

- `validateTagReferences(config, composeServices)` calls the **pure** `buildTagIndex({ mapping, universe: composeServices, source })` from `./tags/tag-index.js` — passing the universe you already hold — and reports, as `ValidationWarning`s: the returned `unresolvedServices`, and every returned `TagNormalizationWarning` (e.g. `Tag 'Media/Streaming' for service 'plex' was normalized to 'media/streaming'`).
- `validateTagLayerOwnership(cwd?)` emits a `ValidationWarning` whenever **more than one** config layer defines a top-level `tags:` key, because layering is wholesale replacement (§5.4) and a personal override silently discards the whole fleet taxonomy. Use `listConfigLayerPaths()` from `./config.js`; parse each layer with the `yaml` package and check for the key. **Name the winning layer's absolute path** in the message.

**Two traps, both fatal if missed (§9.2):**

1. **WARNING SEVERITY ONLY — never `severity: "error"`.** `validateGroupReferences` uses `severity: "error"` for its malformed-shape branch, and `actions/deploy.ts:392-406` calls `hasErrors()` and **ABORTS**. An error-severity tag check would block **every deploy** on one stale `tags.mapping` entry.
2. **`validateTagReferences` MUST NOT THROW.** `validateConfigAgainstCompose` wraps its whole body in try/catch and converts **any** throw into `{ severity: "error" }` at `:337-341` — which lands you back in trap 1. Wrap the `buildTagIndex` call in try/catch **inside** `validateTagReferences` and report the caught `ConfigValidationError`'s message as a **warning**.

**B. Barrels.**

- Create `src/lib/tags/index.ts` re-exporting all six tag modules: `tag-path.js`, `tag-pattern.js`, `tag-index.js`, `tag-suggestions.js`, `tag-inference-rules.js`, `tag-inference.js`. Use value `export { … }` for values and `export type { … }` where the neighbours do (`isolatedModules` + `verbatimModuleSyntax`). **Check for name collisions** — `findClosestTag` is exported from both `tag-suggestions.ts` and re-exported from `tag-index.ts`; export it from **one** place only.
- Extend `src/lib/index.ts` to re-export `./selector.js`, `./command-options.js`, and `./tags/index.js`, matching the file's **existing explicit-named-export style** exactly (it does not use blanket `export *` except for `./errors.js`). Add the new modules to the header doc-comment list.
- **`TagSelectorEmptyError` is ALREADY auto-exported** via the existing `export * from "./errors.js"` at the bottom of `lib/index.ts` — do **not** add a duplicate.

**Other traps.** Do not change `validateGroupReferences`'s existing severities. `.js` import extensions everywhere. §1.2 cardinal rule; §1.6 typecheck discipline.

**doneWhen.**

- `cd $WT && npm run typecheck --workspace packages/rfapps-cli` exits 0
- `cd $WT/packages/rfapps-cli && umask 022 && env -u FORCE_COLOR npx vitest run src/lib/validation.spec.ts` passes
- `validateTagReferences` has a try/catch around `buildTagIndex` and **no `throw`** on any path
- The two new tag validators emit only `severity: "warning"`
- `cd $WT && ! grep -q 'parseComposeFile' packages/rfapps-cli/src/lib/tags/tag-index.ts` _(the no-cycle assertion, re-checked from this side)_
- `import { hasExplicitSelector, addServiceTargetOptions } from "./lib/index.js"` resolves (verify by grep on `lib/index.ts`)

---

#### T12 — `rfapps tag list/show/suggest` — command registrar, both actions, and their two specs

**Owned files (all write):**

- `packages/rfapps-cli/src/commands/tag.ts` (new, ~160 LOC)
- `packages/rfapps-cli/src/actions/tag.ts` (new, ~190 LOC)
- `packages/rfapps-cli/src/actions/tag-suggest.ts` (new, ~150 LOC)
- `packages/rfapps-cli/src/actions/tag.spec.ts` (new) — **PLAN ADDITION**
- `packages/rfapps-cli/src/actions/tag-suggest.spec.ts` (new) — **PLAN ADDITION**

**Read-only context:** `packages/rfapps-cli/src/commands/state.ts:1-60` (the injectable-DI + `.configureHelp` template), `packages/rfapps-cli/src/actions/harden.ts:108-125` (`resolveHardenFormat`), `:146-151` (`--list-rules` early return), `:265-280` (the `flag: "wx"` write + EEXIST handling), `packages/rfapps-cli/src/commands/backup.ts:87-94` (the csv rejection precedent), `packages/rfapps-cli/src/lib/formatters/index.ts` (`FormatOptions`).

**Design sections:** §6.1, §6.4, §6.5, §6.6, §8.1, §8.5, §9.1, §11

**Brief.**

Build the **READ-ONLY** `rfapps tag` command group. **There is NO `tag set` / `add` / `remove` in v1** (MO-1) — the config writer is deferred to a follow-up issue filed by T22. **Do not add a mutation subcommand or an `--apply` flag anywhere in this task.**

**`src/commands/tag.ts`** — export `registerTagCommand(program, dependencies = defaultDependencies)` using the **injectable-DI style** of `commands/state.ts` (read it: `StateCommandDependencies` with `loadXAction(): Promise<{ … }>` members and a `defaultDependencies` const of dynamic imports), because `actions/completion.spec.ts` derives the Commander option surface from registrars without spawning a subprocess, and T20's `commands/tag.spec.ts` asserts injected loaders are never called during registration. Also export `validateTagShowOptions` and `validateTagSuggestOptions` (dispatched later from T17's `cli.ts` preAction hook).

**Chain `.configureHelp({ showGlobalOptions: true })` on the PARENT `tag` command BEFORE any subcommand is created** — Commander copies the parent's help config into a subcommand at creation time (load-bearing comment at `commands/state.ts:52-54`). Getting this wrong silently drops `Global Options:` from every `tag <sub> --help`.

The option surface must be **exactly** this (the completion parity tests consume it verbatim):

| Subcommand    | Options                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tag list`    | `--tree`, `-f/--compose <path>`, `-e/--env-file <path>`, `-p/--profile <name>`, `--json`                                                                            |
| `tag show`    | `-s/--service <name>`, `--services <names>`, `-f`, `-e`, `-p`, `--json`                                                                                             |
| `tag suggest` | `-s/--service <name>`, `--services <names>`, `-g/--group <name>`, `--rule <ids>`, `--list-rules`, `--include-tagged`, `-o/--out <path>`, `-f`, `-e`, `-p`, `--json` |

Actions are **lazily imported inside `.action()`** (`const { executeTagList } = await import("../actions/tag.js")`).

**`src/actions/tag.ts`** — `executeTagList` and `executeTagShow`, returning `TagListResult` / `TagShowResult` from §4.1 with `schemaVersion: TAGS_SCHEMA_VERSION`. `tag list --tree` renders the indented tree from §6.5 to **stdout** with all prose to **stderr**. `tag list` on an **empty taxonomy exits 0** with a stderr pointer to `rfapps tag suggest`.

**`src/actions/tag-suggest.ts`** — `executeTagSuggest`. Call `parseComposeFile` for the universe, build the index via `getTagIndex(config, composePath, universe)`, call the engine in `../lib/tags/tag-inference.js` **passing the index in**, print the human table from §8.5 to **stderr** and the YAML fragment to **stdout** so `rfapps tag suggest > frag.yaml` works. `--list-rules` prints the catalog to stderr and **returns early**. `--out <path>` writes with `writeFile(path, content, { encoding: "utf8", flag: "wx" })` — non-clobbering.

> **PLAN-RESOLVED DESIGN CONFLICT — `--out` EEXIST exit code.** Design §6.6 lists _`--out` target already exists_ as exit **1** `OperationalError`, but the precedent it cites (`actions/harden.ts:270-276`) throws `InvalidArgumentError("--out", path, "file already exists")` → exit **2**. **Resolution: follow the in-repo precedent — catch EEXIST and throw `InvalidArgumentError("--out", <path>, "file already exists")`, exit 2.** Reason: consistency with the only existing `wx` writer in the package outweighs a table row that contradicts its own cited precedent. T21 documents exit 2, and `tag-suggest.spec.ts` pins it.

It writes **nothing** to configuration, has **no `--apply`**, and does **not** take the global state lock.

**Format resolution (§6.5) — MANDATORY ORDER.** The global `--output` is declared with `.default("text")` (`cli.ts:136-140`), so `program.opts().output` is **never `undefined`**. Each subcommand's local `--json` MUST be checked **BEFORE** `globalOptions.output`, copying `resolveHardenFormat` (`actions/harden.ts:108-125`) exactly. Otherwise `--json` is permanently dead.

**Reject `--output csv`** for `tag list` and `tag show` with `InvalidArgumentError("--output", "csv", "Tag output is hierarchical; use json, yaml, or table")` — the `commands/backup.ts:87-94` precedent. `--output table` IS accepted and renders a flattened `tag | depth | services | count` view via `FormatOptions.columns`.

**IMPORT TAG MODULES BY DIRECT PATH** (`../lib/tags/tag-index.js`, `../lib/tags/tag-inference.js`, `../lib/tags/tag-inference-rules.js`) — the `lib/tags/index.ts` barrel is being written by T11 in this same batch.

**SPECS — PLAN ADDITION closing a real §11 coverage hole.** Design §11 assigns "writes nothing" and "`--out` with an existing file throws" to `tag-inference.spec.ts`, but both live in **this** task's action layer, and neither `T10` nor `T20` can reach them. Write:

`src/actions/tag-suggest.spec.ts` — three required cases:

1. **`executeTagSuggest` writes nothing to configuration under every mode** (`--json`, text, `--include-tagged`, `--rule`, degraded) with `node:fs/promises` `writeFile` and `node:fs` `writeFileSync` spied and asserted un-called.
2. **`--out <existing path>` throws `InvalidArgumentError("--out", path, "file already exists")`** — pins the plan-resolved §6.6 conflict above.
3. **Local `--json` beats the global `--output` `.default("text")`** — the §6.5 dead-flag trap.

`src/actions/tag.spec.ts` — two required cases:

1. **Local `--json` beats the global `--output` default** for `executeTagList` and `executeTagShow`.
2. **`--output csv` is REJECTED** with `InvalidArgumentError("--output", "csv", …)` for both.

Deliberately **not** tested here: the `--tree` render and the fragment string byte-for-byte (cosmetic, §11).

**Traps.**

1. Subcommand names `list` / `show` / `suggest` are chosen because `resolveStateLockOperation` (`cli.ts:82-123`) tests `ALWAYS_MUTATING_COMMANDS.has(commandName)` on the **bare** subcommand name — a subcommand named `apply`, `build`, `delete`, `deploy`, `prune`, `pull`, `rebuild`, `rollback`, or `stop` would **silently acquire the global state lock**. Do not rename them.
2. Every tag surface is read-only: exit 0 on success **including zero tags and zero proposals**; malformed pattern → exit 2 `InvalidArgumentError`; malformed `tags.mapping` → exit 2 `ConfigValidationError`. Do **not** add a `resolveTagExitCode` / `setTagExitCode` pair.
3. There is **no positional pattern** on `tag list` — query-vs-select would create two exit contracts for the same syntax.
4. **No MCP surface** — do not touch `src/mcp/`.
5. §1.2 cardinal rule; §1.6 typecheck discipline.

**doneWhen.**

- `cd $WT && npm run typecheck --workspace packages/rfapps-cli` exits 0
- `cd $WT/packages/rfapps-cli && umask 022 && env -u FORCE_COLOR npx vitest run src/actions/tag.spec.ts src/actions/tag-suggest.spec.ts` passes with all five named cases
- `.configureHelp({ showGlobalOptions: true })` is chained on the parent `tag` command **before** the first `.command(...)` call
- The three subcommands declare exactly the option sets in the table above
- `cd $WT && git status --short packages/rfapps-cli/src/mcp/` is empty
- Actions import tag modules via `../lib/tags/<module>.js`, never `../lib/tags/index.js`
- The only file write is the `--out` path and it uses `flag: "wx"`; EEXIST throws `InvalidArgumentError`
- `cd $WT && ! grep -qE '"--apply"|command\("(set|add|remove)"' packages/rfapps-cli/src/commands/tag.ts`

---

#### T13 — Resolver chokepoint: the tag axis in `resolveServicesWithInteractive` + interactive-check

**Owned files (all write):**

- `packages/rfapps-cli/src/lib/interactive-selection.ts`
- `packages/rfapps-cli/src/lib/interactive-check.ts`
- `packages/rfapps-cli/src/lib/interactive-selection.spec.ts`
- `packages/rfapps-cli/src/lib/interactive-check.spec.ts`

**Read-only context:** `packages/rfapps-cli/src/lib/selector.ts` (T09), `packages/rfapps-cli/src/lib/tags/tag-index.ts` (T08), `packages/rfapps-cli/src/lib/errors.ts` (T02), `packages/rfapps-cli/src/lib/validation.ts:113-151` (`parseComposeFile`, `validateServiceNames`), `packages/rfapps-cli/src/actions/{backup,reconcile,update}.ts` (the three DI seams T15 will point at your exported type).

**Design sections:** §7.1, §7.2, §7.4, §7.6, §7.8, §11, §12

**Brief.**

This is the single chokepoint through which all 20 resolver-backed command paths inherit `--tag`. It is the **highest-blast-radius edit in the feature** — a mistake here silently targets the wrong containers on `deploy` / `delete`.

**IMPORT TAG MODULES BY DIRECT PATH** (`./tags/tag-index.js`) — the `lib/tags/index.ts` barrel is being written by T11 in this same batch.

**A. `src/lib/interactive-selection.ts`.**

1. `ResolveOptions` (`:36-46`) already `extends ServiceTargetOptions`, which gained `tag?` in T01 — **verify, do not duplicate.**
2. **EXPORT** the options interface as `ResolveServicesSelection` (currently a non-exported `interface ResolveOptions`) and add the shared DI function type, so T15 can collapse three duplicated structural copies (§7.6):

```ts
export interface ResolveServicesSelection extends ServiceTargetOptions {
  yes?: boolean;
  sidecars?: boolean;
}
export type ResolveServicesFn<TResult, TExecution> = (
  selection: ResolveServicesSelection,
  config: RfappsConfig,
  composePath: string,
  projectDir: string,
  execution: TExecution,
) => Promise<TResult | null>;
```

The `TExecution` generic accommodates the existing divergence (`backup` uses `Pick<DockerExecOptions, "env" | "replaceEnv">`; `reconcile`/`update` use `{ envTool?: EnvToolExecConfig }`). Keep `resolveServicesWithInteractive`'s own signature source-compatible with its 16 existing call sites.

3. Replace the four inline lines at `:99-104` with `const hasAnyTarget = hasExplicitSelector(rawOptions);` (**selector site 1**).
4. Rewrite the `if (hasAnyTarget)` block per §7.4, in this order:
   - **BASE:** existing group → service → services push, **UNCHANGED** (today's `:106-129`, today's insertion order, including `GroupNotFoundError`).
   - `services = [...new Set(services)];` **UNCHANGED**.
   - **`validateServiceNames(services, composePath)` runs on BASE FIRST** — this is **P3**. _(Today the call at `:132` is unguarded; add a `services.length > 0` guard per §7.4. In practice `hasAnyTarget === true` implies non-empty, so this is behavior-neutral, but it makes the ordering explicit.)_ Running validation **after** the intersection would make `ServiceNotFoundError` **unreachable** whenever `--tag` is present (because `TAGS ⊆ U`, a misspelled name is filtered out before validation sees it), so `rfapps deploy -s plexx --tag "media/**"` would report a misleading _"tag matched nothing"_ instead of _"did you mean plex?"_.
   - **THEN the tag axis, GUARDED. This is a PLAN CORRECTION to design §7.4 — transcribe THIS, not the design's snippet:**

     ```ts
     // P1 is STRUCTURAL: when --tag is absent, NOTHING below runs. No index is
     // built, no compose file is read, no ConfigValidationError can be raised.
     // Design §7.4 writes getTagIndex()/parseComposeFile() as ARGUMENT
     // EXPRESSIONS to applyTagAxis(), which evaluates them unconditionally and
     // silently breaks P1. This guard is the fix.
     if (rawOptions.tag !== undefined && rawOptions.tag.length > 0) {
       const universe = await parseComposeFile(composePath);
       const index = await getTagIndex(config, composePath, universe);
       const axis = applyTagAxis(rawOptions.tag, index, universe);
       if (axis.kind === "present") {
         const base = services.length > 0 ? services : universe;
         const narrowed = base.filter((s) => axis.matched.has(s));
         if (narrowed.length === 0) {
           throw new TagSelectorEmptyError(
             axis.terms.map((t) => t.source),
             explicitSelectorFlagNames({ ...rawOptions, tag: undefined }),
             [...index.allTags],
             findClosestTag(axis.terms[0]?.source ?? "", index.allTags),
             index.unresolvedServices,
           );
         }
         services = narrowed;
       }
     }
     ```

     `parseComposeFile` is already mtime+size cached in `validation.ts:37-100`. **The fifth `TagSelectorEmptyError` argument `index.unresolvedServices` is the plan-resolved P4 completion** — T02 added it as an optional fifth constructor parameter.

     **Why the guard is not merely an optimization:** without it, a single malformed `tags.mapping` entry makes `getTagIndex` throw `ConfigValidationError` on **`rfapps deploy -s plex` with no `--tag` at all**, across all 20 resolver-backed paths, and every such invocation newly pays `listConfigLayerPaths()` + a YAML parse of every config layer.

5. Lines `:160-178` (`preSidecarCount`, sidecar expansion, `autoDetectProfiles`) stay **UNCHANGED**, and the tag result must land in `services` **BEFORE** `preSidecarCount` is computed (**P6**) so `preSidecarCount` / `sidecarsExpanded` stay meaningful (deploy auto-enables `--force-recreate` on expansion), sidecar expansion behaves normally, and `autoDetectProfiles` populates the `docker compose --profile` argv correctly.

**THE SINGLE MOST IMPORTANT RULE (P2): when the tag axis is present and the result is empty, THROW. NEVER return `[]`.** `services: []` is an overloaded sentinel meaning _"no explicit target — let Compose operate on the whole project"_; callers uniformly do `services.length > 0 ? services : undefined` (`actions/lint.ts:390`, `harden.ts:222`, `audit.ts:125`) and omit the service list from the `docker compose` argv. A zero-match glob falling through to `[]` would **silently target all 45 services** — including under `rfapps delete`.

**B. `src/lib/interactive-check.ts`.** Add `tag?: string[]` to `InteractiveSelectionCheckOptions` (`:31-40`) and replace the three inline lines at `:63-71` with `hasExplicitSelector(options)` (**selector site 2**). Without this, `rfapps deploy --tag "media/**"` pops the Ink multi-select on a TTY — a real, user-visible bug. **Do NOT add a `candidates?` pre-filter seam to `selectServicesInteractive`**; tag-aware interactive selection is explicitly out of scope (§7.8).

**C. Spec extensions.** `interactive-selection.spec.ts` has **37 existing tests that ARE the backward-compat contract for 19 commands — do not weaken any of them.** Add:

- `--tag` **INTERSECTS** with `-s`/`-g` rather than unioning;
- a zero-match tag **throws `TagSelectorEmptyError` and NEVER returns `[]`**;
- `-s <typo> --tag <valid>` throws **`ServiceNotFoundError`** (P3, not a tag error);
- tag-resolved services reach `autoDetectProfiles` so `profiles` is non-empty;
- `preSidecarCount` reflects the **post**-intersection count;
- **the P1 mechanical proof (PLAN ADDITION):** with `rawOptions.tag === undefined`, spy on `getTagIndex` **and** `parseComposeFile` and assert **neither is called**. This is the only mechanical proof that P1 is structural rather than aspirational.

`interactive-check.spec.ts`: `--tag` alone suppresses interactive selection.

**Other traps.**

- `-p/--profile` needs **no change** — it only sets `config.profiles.defaultProfile` and the resolver consults it only when `services.length === 0`, which `--tag` makes unreachable (§7.7).
- `applyCliOverrides` is a shallow spread so `tags` survives it — do not edit it.
- `vi.clearAllMocks()`, never `resetAllMocks`.
- §1.2 cardinal rule; §1.6 typecheck discipline.

**doneWhen.**

- `cd $WT && npm run typecheck --workspace packages/rfapps-cli` exits 0
- `cd $WT/packages/rfapps-cli && umask 022 && env -u FORCE_COLOR npx vitest run src/lib/interactive-selection.spec.ts src/lib/interactive-check.spec.ts` passes with **all 37 pre-existing tests still present and green**
- The tag branch is wrapped in `if (rawOptions.tag !== undefined && rawOptions.tag.length > 0)`; `getTagIndex` and `parseComposeFile` appear **only inside** it
- The spy-based P1 test exists and passes
- `validateServiceNames` is called **before** the tag intersection in source order
- The zero-match path **throws `TagSelectorEmptyError`**; there is **no code path returning `[]` after a present tag axis**
- `ResolveServicesSelection` and `ResolveServicesFn` are exported from `interactive-selection.ts`
- `cd $WT && ! grep -q 'tags/index.js' packages/rfapps-cli/src/lib/interactive-selection.ts`
- `cd $WT && git status --short packages/rfapps-cli/src/lib/interactive.tsx` is empty

---

### BATCH 5 — Action-layer propagation (no flag declared; completion stays GREEN)

_T14 is 15 files of near-mechanical fan-out. T16 owns the one command that bypasses the resolver entirely. **Neither task declares a Commander flag**, so `completion.spec.ts` stays green through this whole batch and the B5 barrier can run the full `src/actions` glob with no exclusions._

> **PLAN-ADDED REQUIREMENT that all three candidate plans missed — verified against the tree.** Every action file declares its **own local `Raw*Options` interface** (e.g. `interface RawDeployOptions { service?: string; services?: string; group?: string; … }` at `actions/deploy.ts:101`). Adding `tag: rawOptions.tag` **will not typecheck** unless that local interface also gains `tag?: string[]`. Required in T14, T15, and T16. The interfaces are co-located in the file each task already owns, so no ownership conflict arises.

---

#### T14 — Propagate `tag` through the 16 direct resolver call sites

**Owned files:**

| files                                                                                                                                                                                                                       | mode                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `packages/rfapps-cli/src/actions/` → `health.ts`, `deploy.ts`, `rebuild.ts`, `pull.ts`, `stop.ts`, `build.ts`, `audit.ts`, `delete.ts`, `import.ts`, `harden.ts`, `doctor.ts`, `plan.ts`, `lint.ts`, `prune.ts`, `drift.ts` | write                                               |
| the 14 co-located `*.spec.ts` for those modules that have one (`deploy`, `rebuild`, `pull`, `stop`, `audit`, `delete`, `import`, `harden`, `doctor`, `plan`, `lint`, `prune`, `drift`, `health`)                            | reserved (additive `tag?` only; no change expected) |

**Read-only context:** `packages/rfapps-cli/src/types/options.ts` (T01), `packages/rfapps-cli/src/mcp/adapters.ts:206-228` (the explicit-literal-keys pattern — **frozen**).

**Design sections:** §9.3, §9.7, §4.3

**Brief.**

Near-mechanical fan-out across 15 action files. In each file there are **three** things to update:

1. **The local `Raw*Options` interface** — add `tag?: string[];` immediately after `group?: string;`. Interfaces to edit (verified anchors): `RawHealthOptions` (`health.ts:31`), `RawDeployOptions` (`deploy.ts:101`), `RawRebuildOptions` (`rebuild.ts:59`), `RawPullOptions` (`pull.ts:42`), `RawStopOptions` (`stop.ts:41`), `RawBuildOptions` (`build.ts:51`), `RawAuditOptions` (`audit.ts:28`), `RawDeleteOptions` (`delete.ts:48`), `RawImportOptions` (`import.ts:58`), `RawHardenOptions` (`harden.ts:55`), `RawDoctorOptions` (`doctor.ts:28`), `RawPlanOptions` (`plan.ts:57`), `RawLintOptions` (`lint.ts:54`), `RawPruneOptions` (`prune.ts:53`), and in `drift.ts`: `RawDriftDetectOptions` (`:52`), `RawDriftReconcileOptions` (`:78`), `RawDriftImportOptions` (`:91`). **`RawDriftShowOptions` (`drift.ts:67`) must NOT gain `tag`** — `drift show` is excluded from `--tag` (§6.3).
2. **The raw→typed options builder** (the object carrying `group: rawOptions.group`) — add `tag: rawOptions.tag,` immediately after the `group` line.
3. **The object passed to `resolveServicesWithInteractive`** (the one carrying `group: options.group`) — add `tag: options.tag,` immediately after the `group` line.

**Verified anchor inventory — 31 `group:` keys across these 15 files.** Use `grep -n 'group: rawOptions.group\|group: options.group' <file>` on each owned file; **grep, do not trust line numbers blindly:**

| file         | `group: rawOptions.group`                                        | `group: options.group` |
| ------------ | ---------------------------------------------------------------- | ---------------------- |
| `audit.ts`   | 80                                                               | 109                    |
| `build.ts`   | 108                                                              | 159                    |
| `delete.ts`  | 107                                                              | 135                    |
| `deploy.ts`  | 270                                                              | 414                    |
| `doctor.ts`  | 80                                                               | 112                    |
| `drift.ts`   | 392, 667                                                         | 419, 694               |
| `harden.ts`  | 187                                                              | 206                    |
| `health.ts`  | 65                                                               | 101                    |
| `import.ts`  | **271 (only site — inline resolve object, no separate builder)** | —                      |
| `lint.ts`    | 347                                                              | 374                    |
| `plan.ts`    | 390                                                              | 432                    |
| `prune.ts`   | 115                                                              | 143                    |
| `pull.ts`    | 97                                                               | 125                    |
| `rebuild.ts` | 122                                                              | 174                    |
| `stop.ts`    | 96                                                               | 122                    |

**Also grep each owned file for the conditional-spread idiom** `...(options.group === undefined ? {} : { group: options.group })` / `...(group === undefined ? {} : { group })`. Where a builder uses it, **match that idiom** for `tag` in that file rather than introducing a bare assignment — a bare `tag: options.tag` in a spread-idiom object would create the key with value `undefined`. _(The known instances of this idiom live in T15's files, not yours, but grep anyway.)_

**Do not change anything else in these files.** No refactors, no reformatting, no logic edits. No new import is needed — `tag?: string[]` is already on `ServiceTargetOptions`.

**MCP trap (§9.7) — the rule is "NEVER CREATE THE KEY", not "never populate it".** `src/mcp/adapters.ts` builds raw CLI option objects with **explicit literal keys and no spread** (verified at `invokeStatus`, `adapters.ts:206-228`), which is exactly what makes adding `tag?` to the TypeScript types safe. **Do NOT introduce an object spread of an MCP-supplied argument into any of these builders**, and **do NOT touch `src/mcp/`**. `schemaObject` is `additionalProperties: false` and iterates `Object.keys(input)`, so a `{ tag: undefined }` key would throw `Unexpected properties at $: tag` at MCP runtime while typechecking clean.

**Other traps.** `--tag` is never defaulted to `[]`, so `options.tag` may legitimately be `undefined` — pass it through untouched; `applyTagAxis` short-circuits on `undefined` (P1). Do **not** add a `tags` field to any result type. `packages/rfapps-cli/src/actions/status.ts` is owned by **T16 in this same batch** and `packages/rfapps-cli/src/actions/{backup,reconcile,update}.ts` are owned by **T15 in batch 6** — do not open or edit any of them. §1.2 cardinal rule; §1.6 typecheck discipline.

**doneWhen.**

- `cd $WT && npm run typecheck --workspace packages/rfapps-cli` exits 0
- `cd $WT && grep -rn 'tag: rawOptions.tag\|tag: options.tag\|{ tag: options.tag }\|{ tag }' packages/rfapps-cli/src/actions/{health,deploy,rebuild,pull,stop,build,audit,delete,import,harden,doctor,plan,lint,prune,drift}.ts | wc -l` returns `31`
- Every `group?: string;` in the 17 targeted `Raw*Options` interfaces has an adjacent `tag?: string[];`; `RawDriftShowOptions` does **not**
- `cd $WT && git diff --stat -- packages/rfapps-cli/src/actions` shows only additive one-line changes in these 15 files
- `cd $WT && git status --short packages/rfapps-cli/src/mcp/` is empty
- **Scoped test gate (NOT the `src/actions` glob — T16 is editing `status.ts` concurrently):**
  `cd $WT/packages/rfapps-cli && umask 022 && env -u FORCE_COLOR npx vitest run src/actions/deploy.spec.ts src/actions/rebuild.spec.ts src/actions/pull.spec.ts src/actions/stop.spec.ts src/actions/audit.spec.ts src/actions/delete.spec.ts src/actions/import.spec.ts src/actions/harden.spec.ts src/actions/doctor.spec.ts src/actions/plan.spec.ts src/actions/lint.spec.ts src/actions/prune.spec.ts src/actions/drift.spec.ts src/actions/health.spec.ts` passes _(omit any file that does not exist; do not add the missing ones)_

---

#### T16 — `status --tag`: the one command off the resolver pipeline

**Owned files:**

| file                                             | mode  |
| ------------------------------------------------ | ----- |
| `packages/rfapps-cli/src/actions/status.ts`      | write |
| `packages/rfapps-cli/src/actions/status.spec.ts` | write |

> **The `src/cli.status.integration.spec.ts` cases are NOT in this task.** They spawn the real `cli.ts`, where `--tag` is not declared on `status` until T17 in batch 7. They are **T24, batch 8**.

**Read-only context:** `packages/rfapps-cli/src/mcp/schema.ts:218-227` (`serviceStatusSchema` — **frozen**), `packages/rfapps-cli/src/lib/selector.ts`, `packages/rfapps-cli/src/lib/tags/tag-index.ts`.

**Design sections:** §7.9, §11, §12

**Brief.**

`actions/status.ts` **never** calls `resolveServicesWithInteractive`. It shells `listContainers(options.all)` → `docker ps --format json` and post-filters on **container names** (verified at `:299-308`). It hardcodes `noSidecars: false` / `yes: false`, has **no `-g`**, **no `-p/--profile`**, and never computes profiles. Add the bespoke tag path per §7.9, in the range `:231-320`.

1. Add `tag?: string[];` to the **local `RawStatusOptions`** interface (verified at `status.ts:47-56`) — it is a bespoke local interface and does **not** extend `ServiceTargetOptions`, so T01's fan-out does not reach it. `StatusOptions` (from `types/options.ts`) already carries `tag?`.
2. Populate `tag: rawOptions.tag` in the `StatusOptions` builder at `:242-257`.

**Algorithm:**

- `options.tag === undefined` (or an empty array) → **the code path is UNCHANGED. Nothing new runs.** This is the structural backward-compatibility guarantee for the hottest command in the CLI, and it must be a real `if` guard, not an argument expression.
- When `options.tag` is present:
  a. `loadConfig()` + `applyCliOverrides` — already done at `:260-265`, reuse it.
  b. `const universe = await parseComposeFile(finalConfig.composePath)` — already mtime+size cached.
  c. `const index = await getTagIndex(finalConfig, finalConfig.composePath, universe)`.
  d. `const axis = applyTagAxis(options.tag, index, universe)`.
  e. BASE = the names from `-s` / `--services`, else the whole `universe`.
  f. `selectedServices = materialize(BASE) ∩ axis.matched`; if **EMPTY**, **throw `TagSelectorEmptyError`** (exit 2), consistent with every other command.
  g. In the `for (const line of lines)` loop, keep a `docker ps` row iff `selectedServices.has(data.Names)`.

**Step (g) uses the SERVICE-KEY FALLBACK ONLY.** Do **NOT** add a `getServiceContainerMap` / `docker compose ps` round-trip — explicitly dropped from scope (§7.9, §13.3). `status` today reads no compose file for its container list and shells only a bare `docker ps`; adding a compose subprocess to the hottest command to preempt a divergence that does not exist here is a latency regression bought for a hypothetical. Measured: all 45 services declare `container_name` identical to the service key, zero exceptions.

**NAME SHADOWING TRAP.** `actions/status.ts:301` already binds `const { name, tag } = parseImage(data.Image)` **inside the exact loop that gains the filter** — there, `tag` means the **image tag**. Bind the incoming option locally as `tagPatterns` and the resolved set as `selectedServices`. Conflating them is a silent wrong-filter bug.

**MOCKING STRATEGY (PLAN-SPECIFIED — do not improvise).** Verified: `status.ts:40` imports its lib surface via `from "../lib/index.js"`, and `status.spec.ts:7` does a **full automock** `vi.mock("../lib/index.js")`. Therefore:

- **Reach `getTagIndex` and `applyTagAxis` through the existing `../lib/index.js` barrel import**, consistent with the rest of the file (T11's barrel already re-exports both by the time this batch runs).
- In `status.spec.ts`, every new case must supply explicit `vi.mocked(lib.getTagIndex).mockResolvedValue(...)` / `vi.mocked(lib.applyTagAxis).mockReturnValue(...)` / `vi.mocked(lib.parseComposeFile).mockResolvedValue(...)` values — the automock returns `undefined` otherwise.
- **Do NOT switch to direct-path imports** to dodge the automock: that would perform real config-layer and compose-file I/O inside a unit spec.

**COMPOSITION IS INTERSECTION, matching the resolver.** `status --tag "media/**" -s traefik` and `rebuild --tag "media/**" -s traefik` must behave **identically** (both select `traefik` only if it is tagged `media/**`). Divergent semantics for identical syntax across commands is exactly what produces a wrong-target incident.

**`ServiceStatus` GAINS NO NEW FIELD.** It is MCP-surfaced via `serviceStatusSchema` (`src/mcp/schema.ts:218-227`) and anchored by `_typeCheck` at `:1088-1113`. Do not touch `src/mcp/`. Note `ServiceStatus` already has a `tag` field meaning "image tag" — that collision is **documented, not fixed**.

**`status --tag` matching nothing exits 2.** `status -s bogus` exiting 0 today is a pre-existing inconsistency (status never calls `validateServiceNames`); do not propagate it to the tag path.

**Spec (`status.spec.ts`), three required cases:**

1. `options.tag === undefined` → **neither `getTagIndex` nor `parseComposeFile` is called** (spy-asserted). The P1 proof for the hottest command.
2. `--tag <pattern>` filters `docker ps` rows down to `axis.matched ∩ BASE`.
3. `--tag <no-match>` throws `TagSelectorEmptyError`.

**Traps.** §1.2 cardinal rule; §1.6 typecheck discipline. `vi.clearAllMocks()`, never `resetAllMocks`.

**doneWhen.**

- `cd $WT && npm run typecheck --workspace packages/rfapps-cli` exits 0
- `cd $WT/packages/rfapps-cli && umask 022 && env -u FORCE_COLOR npx vitest run src/actions/status.spec.ts` passes with all three named cases
- `status.ts` binds incoming patterns as `tagPatterns` and never shadows the `parseImage` `tag` binding
- `cd $WT && ! grep -qE 'getServiceContainerMap|compose ps' packages/rfapps-cli/src/actions/status.ts`
- `cd $WT && git status --short packages/rfapps-cli/src/testing/ packages/rfapps-cli/src/mcp/` is empty

---

### BATCH 6 — Flag declaration on the ten dedicated registrars

_T15 and T18 own strictly disjoint files. **This is where `completion.spec.ts` goes red** (backup, reconcile, harden, import parity) — see §1.4. That is planned; neither task may touch `completion.ts` or `completion.spec.ts`. Both tasks' `--help` smoke checks are demoted to the barrier gate because `npm run rfapps` loads `cli.ts`, which loads **both** agents' in-flight registrars._

---

#### T15 — DI seams + selector sites 4/5/6 + `backup --all` and `update --from-plan` conflicts + flag declaration

**Owned files:**

| file                                                                                               | mode     |
| -------------------------------------------------------------------------------------------------- | -------- |
| `packages/rfapps-cli/src/actions/backup.ts`                                                        | write    |
| `packages/rfapps-cli/src/actions/reconcile.ts`                                                     | write    |
| `packages/rfapps-cli/src/actions/update.ts`                                                        | write    |
| `packages/rfapps-cli/src/commands/backup.ts`                                                       | write    |
| `packages/rfapps-cli/src/commands/update.ts`                                                       | write    |
| `packages/rfapps-cli/src/commands/backup.spec.ts`                                                  | write    |
| `packages/rfapps-cli/src/commands/update.spec.ts`                                                  | write    |
| `packages/rfapps-cli/src/actions/reconcile.spec.ts`                                                | write    |
| `packages/rfapps-cli/src/actions/backup.spec.ts`, `packages/rfapps-cli/src/actions/update.spec.ts` | reserved |

> `packages/rfapps-cli/src/commands/reconcile.spec.ts` is **T18's**, not yours. Do not open it.

**Read-only context:** `packages/rfapps-cli/src/lib/selector.ts` (T09), `packages/rfapps-cli/src/lib/interactive-selection.ts` (T13's `ResolveServicesFn`), `packages/rfapps-cli/src/lib/command-options.ts` (T03).

**Design sections:** §7.5, §7.6, §7.7, §11, §12

**Brief.**

Four of the six duplicated selector sites plus the two DI-seam families live here. **Sites 5 and 6 are MANDATORY, NOT OPTIONAL** — skipping either produces a wrong-scope bug on a mutating, lock-taking command.

**Selector site 4 — `src/actions/reconcile.ts:646-657`.** Replace the two inline lines computing an explicit-selector boolean (verified at `:647`) with `hasExplicitSelector(options)` imported from `../lib/selector.js`, and derive the downstream `InvalidArgumentError` flag names (`:650-655`, `:683-690`) with `explicitSelectorFlagNames`. Without this, a zero-match tag reconciles the entire fleet.

**Selector site 5 — `src/commands/backup.ts:73-77`.** Replace the 3-element `selectorFlags` array literal (verified: `--service`, `--services`, `--group`) with `explicitSelectorFlagNames(options)`. Without it, `rfapps backup --all --tag "media/**"` **passes** the mutual-exclusion check (which sees only the three legacy flags), the `--all` branch wins, and the whole project is backed up with `--tag` silently ignored.

**Selector site 6 — `src/actions/backup.ts:472-485`.** Replace the duplicated 3-element array-literal guard with `explicitSelectorFlagNames(rawOptions)`. Without it, `rfapps backup --tag "media/**" --yes` computes `explicitTarget = false` and throws _"Backup requires an explicit service target or --all"_ **despite having one**.

**`src/commands/update.ts:23-30` — add `--tag` to the `--from-plan` conflict list.** Verified: the array today is exactly `--service`, `--services`, `--group`, `--compose`, `--profile`, `--no-sidecars`, built with `options.X === undefined ? undefined : "--X"`. Without the edit, `rfapps update --from-plan reviewed.json --tag "media/**" --apply` **silently re-scopes a frozen, reviewed managed-update plan** on a command that holds the global state lock and recreates containers.

**Shared DI signature (§7.6).** `actions/backup.ts:119-132`, `actions/reconcile.ts:129-142`, and `actions/update.ts:130-143` each **re-declare** the `resolveServices` signature structurally. Replace all three with `ResolveServicesFn<TResult, TExecution>` exported from `../lib/interactive-selection.js`, instantiating `TExecution` per file (`backup` → `Pick<DockerExecOptions, "env" | "replaceEnv">`; `reconcile`/`update` → `{ envTool?: EnvToolExecConfig }`).

**Type + value fan-out — FIVE `group` sites, not four (PLAN CORRECTION, verified in the tree).**

Interfaces that must gain `tag?: string[]`:

| interface                        | anchor                | extends `ServiceTargetOptions`?          |
| -------------------------------- | --------------------- | ---------------------------------------- |
| `RawBackupOptions`               | `backup.ts:64`        | no                                       |
| `RawReconcileOptions`            | `reconcile.ts:56`     | no                                       |
| `RawUpdateOptions`               | `update.ts:78`        | no                                       |
| **`NormalizedReconcileOptions`** | **`reconcile.ts:79`** | **NO — T01's fan-out does NOT reach it** |
| **`NormalizedUpdateOptions`**    | **`update.ts:93`**    | **NO — T01's fan-out does NOT reach it** |

The five `group` value sites:

| file:line              | shape                                                                      | what to add                                                           |
| ---------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `backup.ts:554`        | plain key                                                                  | `tag: rawOptions.tag,`                                                |
| **`reconcile.ts:263`** | **`...(group === undefined ? {} : { group }),` inside `normalizeOptions`** | **`...(tag === undefined ? {} : { tag }),` — MATCH THE SPREAD IDIOM** |
| `reconcile.ts:633`     | `...(options.group === undefined ? {} : { group: options.group }),`        | match the spread idiom                                                |
| `update.ts:299`        | plain key                                                                  | `tag: rawOptions.tag,`                                                |
| `update.ts:602`        | plain key                                                                  | `tag: options.tag,`                                                   |

> **`reconcile.ts:263` is the site every candidate plan missed.** It does **not** contain the literal string `group: rawOptions.group`, so a `grep -n 'group: rawOptions.group'` recipe skips it. Without it, `options.tag` at `:633` is permanently `undefined`, so `rfapps reconcile --tag …` declares the flag and **silently drops it** on a mutating, lock-taking command — and `executeDriftReconcile` (`actions/drift.ts:624-629`) is `executeReconcile({ ...rawOptions, autoApply: true }, …)`, so `rfapps drift reconcile --tag …` inherits the same silent drop.

**Flag declaration.**

- `src/commands/update.ts:46-49` declares the contiguous block `-s/--service`, `--services`, `-g/--group`, `--no-sidecars` (verified). **REPLACE those four `.option()` calls** with `addServiceTargetOptions(cmd)` from `../lib/command-options.js`.
- `src/commands/backup.ts:138-142` declares `-s`, `--services`, `-g`, **`--all`**, `--no-sidecars` — the block is **not contiguous**, so `addServiceTargetOptions` cannot be applied wholesale. **Use the inline escape hatch:** insert the identical `--tag` collector immediately after `-g, --group`, leaving `--all` and `--no-sidecars` exactly where they are.

**REPLACE, DO NOT APPEND.** Verified in this tree: Commander throws `Cannot add option '-s, --service <n>' to command 'x' due to conflicting flag '--service'` at registration time on a duplicate declaration, which kills every `rfapps` invocation. **NO `[]` DEFAULT and NO throwing argParser** — with an `[]` default, `options.tag` would never be `undefined`, so `rfapps update --from-plan <path>` would throw on **every** invocation and `rfapps backup --all` would **always** report a selector conflict.

**Spec extensions.**

- `commands/backup.spec.ts`: `backup --all --tag "x"` throws the mutual-exclusion error; `backup --tag "x" --yes` does **not** throw _"requires an explicit target"_.
- `commands/update.spec.ts`: `update --from-plan p.json --tag "x"` throws; **`update --from-plan p.json` ALONE does NOT throw** — that second case is the regression test for the Commander-default trap and **must be present**.
- `actions/reconcile.spec.ts` (**PLAN ADDITION**): `executeReconcile` with `tag: ["media/**"]` reaches `dependencies.resolveServices` with a **non-`undefined`** `tag` — the only mechanical proof that `reconcile.ts:263` was not missed.

**Other traps.**

- `backup --all` is the only real "target everything" flag and becomes mutually exclusive with `--tag` for free once sites 5 and 6 use `explicitSelectorFlagNames`. `status`'s `-a/--all` means `docker ps -a` and is **not** conflated.
- **`src/actions/completion.spec.ts` WILL GO RED** the moment you declare `--tag` on `commands/backup.ts` (backup parity, `:438`). **This is expected (§1.4). It is T19-owned and T19-repaired in batch 8. Do not touch `completion.ts` or `completion.spec.ts`.**
- **Do not run `npm run rfapps -- <cmd> --help`** — it loads `cli.ts`, which loads T18's in-flight registrars. The `--help` smokes run at the **barrier**.
- Do not touch `src/mcp/`. §1.2 cardinal rule; §1.6 typecheck discipline.

**doneWhen.**

- `cd $WT && npm run typecheck --workspace packages/rfapps-cli` exits 0
- `cd $WT/packages/rfapps-cli && umask 022 && env -u FORCE_COLOR npx vitest run src/commands/backup.spec.ts src/commands/update.spec.ts src/actions/backup.spec.ts src/actions/reconcile.spec.ts src/actions/update.spec.ts` passes _(scoped to owned specs only)_
- `cd $WT && grep -c 'tag' packages/rfapps-cli/src/actions/reconcile.ts` is **≥ 4** and both `reconcile.ts:263` and `reconcile.ts:633` carry a `tag` spread
- `NormalizedReconcileOptions` and `NormalizedUpdateOptions` both declare `tag?: string[]`
- No array literal of selector flag names remains in `commands/backup.ts` or `actions/backup.ts`
- `commands/update.ts`'s `--from-plan` conflict list contains `--tag`
- All three action files reference `ResolveServicesFn` instead of a locally re-declared `resolveServices` signature
- The `update --from-plan p.json` **alone does-not-throw** case exists in `update.spec.ts`
- `cd $WT && git status --short packages/rfapps-cli/src/actions/completion.ts packages/rfapps-cli/src/actions/completion.spec.ts packages/rfapps-cli/src/commands/reconcile.spec.ts packages/rfapps-cli/src/cli.ts` is empty

---

#### T18 — Declare `--tag` on the six dedicated command registrars (+ the pinned reconcile option array)

**Owned files:**

| file                                                 | mode                                         |
| ---------------------------------------------------- | -------------------------------------------- |
| `packages/rfapps-cli/src/commands/audit.ts`          | write                                        |
| `packages/rfapps-cli/src/commands/doctor.ts`         | write                                        |
| `packages/rfapps-cli/src/commands/drift.ts`          | write                                        |
| `packages/rfapps-cli/src/commands/harden.ts`         | write                                        |
| `packages/rfapps-cli/src/commands/import.ts`         | write                                        |
| `packages/rfapps-cli/src/commands/reconcile.ts`      | write                                        |
| `packages/rfapps-cli/src/commands/reconcile.spec.ts` | **write — REASSIGNED from T15 by this plan** |

**Read-only context:** `packages/rfapps-cli/src/lib/command-options.ts` (T03).

**Design sections:** §6.2, §6.3, §9.4

**Brief.**

Declare `--tag` on the remaining dedicated command registrars using `addServiceTargetOptions` from `../lib/command-options.js`. Together with `commands/backup.ts` + `commands/update.ts` (T15, same batch, different files) and the 11 inline commands in `cli.ts` (T17, batch 7), this completes the **21 command paths** from §6.3.

**REPLACE, DO NOT APPEND — verified.** All eight target sites declare the **contiguous** four-line block `-s, --service` / `--services` / `-g, --group` / `--no-sidecars`. Delete those four `.option()` calls and put `addServiceTargetOptions(cmd)` in their place. Commander **throws** `Cannot add option '-s, --service <n>' … due to conflicting flag '--service'` at registration time on a duplicate, which kills every `rfapps` invocation — appending is not merely untidy, it is fatal.

**Verified anchors (grep `'-g, --group'` in each owned file and cover every occurrence):** `audit.ts:9`, `doctor.ts:9`, `import.ts:52`, `reconcile.ts:63`, `harden.ts:106`, and `drift.ts` at **three** sites — `:24` (`drift detect`), `:54` (`drift reconcile`), `:69` (`drift import`).

**`drift show` gets NO `--tag`** — it uses a single-service `.requiredOption` at `drift.ts:39` and is explicitly excluded (§6.3). Verify you are touching only the three `drift` subcommands that carry `-g`.

**Insertion position is FIXED and PINNED.** `addServiceTargetOptions` emits long options in the order `--service, --services, --group, --tag, --no-sidecars`. That exact position is asserted by `src/commands/reconcile.spec.ts:42-53`, which is an **exact, order-sensitive `toEqual`** of reconcile's long option names.

**REQUIRED SPEC EDIT (this is why the file was reassigned to you).** In `src/commands/reconcile.spec.ts:42-53`, insert `"--tag"` between `"--group"` and `"--no-sidecars"` so the array reads:

```ts
[
  "--service",
  "--services",
  "--group",
  "--tag",
  "--no-sidecars",
  "--auto-apply",
  "--show-unchanged",
  "--health-timeout",
  "--compose",
  "--env-file",
  "--profile",
];
```

T15 does not touch `commands/reconcile.ts` and its brief never mentioned this array; leaving it with T15 would have left the break un-owned and un-repairable by T23. Do not change any other assertion in that file.

Preserve every other option's **description string** and **relative ordering** exactly.

**Traps.**

1. **No `[]` default, no throwing argParser** — use the shared collector; do not re-declare `--tag` inline with a default.
2. `delete` and `prune` **do** get `--tag` (handled in `cli.ts` by T17). Withholding it would leave an inconsistent surface; the fail-closed empty-match rule (P2) is the actual protection and it is stronger than omission.
3. **`src/actions/completion.spec.ts` WILL GO RED** for reconcile (`:529`), harden (`:602`) and import (`:621`) the moment you land. **This is expected (§1.4), T19-owned, and repaired in batch 8. Do not touch `completion.ts` or `completion.spec.ts`.**
4. **Do not run `npm run rfapps -- <cmd> --help`** — it loads `cli.ts`, which loads T15's in-flight `commands/backup.ts` and `commands/update.ts`. The `--help` smokes run at the **barrier**.
5. Do not edit `commands/backup.ts`, `commands/update.ts`, `commands/backup.spec.ts`, `commands/update.spec.ts`, `commands/tag.ts`, or `cli.ts` — all owned by other tasks. Do not touch `src/mcp/`.
6. §1.2 cardinal rule; §1.6 typecheck discipline.

**doneWhen.**

- `cd $WT && npm run typecheck --workspace packages/rfapps-cli` exits 0
- `cd $WT/packages/rfapps-cli && umask 022 && env -u FORCE_COLOR npx vitest run src/commands/reconcile.spec.ts src/commands/audit.spec.ts src/commands/doctor.spec.ts src/commands/drift.spec.ts src/commands/harden.spec.ts src/commands/import.spec.ts` passes _(omit files that do not exist)_. If the `spawnSync`-based case at `reconcile.spec.ts:170` fails because T15 is mid-edit of a registrar `cli.ts` loads, **wait and re-run; do not edit T15's files.**
- `reconcile.spec.ts:42`'s array contains `"--tag"` between `"--group"` and `"--no-sidecars"`
- Each of the eight target sites now calls `addServiceTargetOptions` and no longer declares `-s/--service`, `--services`, `-g/--group`, or `--no-sidecars` inline
- `cd $WT && ! grep -q '\-\-tag' <(sed -n '37,49p' packages/rfapps-cli/src/commands/drift.ts)` _(`drift show` stays clean)_
- `cd $WT && git status --short packages/rfapps-cli/src/actions/completion.ts packages/rfapps-cli/src/actions/completion.spec.ts packages/rfapps-cli/src/cli.ts packages/rfapps-cli/src/commands/backup.ts packages/rfapps-cli/src/commands/update.ts` is empty

---

### BATCH 7 — `cli.ts`, alone

_T17 is alone in its batch for two reasons, both verified. (1) `cli.ts:393-400`, `:625` and `:660` statically import and call every registrar T18 and T15 edit, so co-batching creates a mutual doneWhen deadlock in which each agent's gate needs the other's file finished. (2) `cli.ts` is the highest-fan-out file in the package and this task bundles five distinct concerns into it. Being alone means every gate here is unambiguous._

---

#### T17 — `cli.ts`: declare `--tag` on 11 inline commands, register `tag`, preAction, selector site 3

**Owned files:** `packages/rfapps-cli/src/cli.ts` — write

**Read-only context:** `packages/rfapps-cli/src/lib/command-options.ts` (T03), `packages/rfapps-cli/src/commands/tag.ts` (T12), `packages/rfapps-cli/src/lib/selector.ts` (T09), `packages/rfapps-cli/src/lib/tags/tag-pattern.ts` (T04).

**Design sections:** §6.1, §6.2, §6.3, §7.5, §9.4

**Brief — five edits to the file you own exclusively.**

**1. Declare `--tag` on the 11 inline commands** via `addServiceTargetOptions` from `./lib/command-options.js`. **Verified anchors — every one of these is a contiguous block you must REPLACE, not append to:**

| command   | block to replace                                                                | helper call                                                       |
| --------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `status`  | `:358-359` (`-s`, `--services` **only** — no `-g`, no `--no-sidecars`, no `-p`) | `addServiceTargetOptions(cmd, { group: false, sidecars: false })` |
| `health`  | `:375-378`                                                                      | `addServiceTargetOptions(cmd)`                                    |
| `pull`    | `:406-409`                                                                      | `addServiceTargetOptions(cmd)`                                    |
| `build`   | `:422-425`                                                                      | `addServiceTargetOptions(cmd)`                                    |
| `deploy`  | `:439-442`                                                                      | `addServiceTargetOptions(cmd)`                                    |
| `stop`    | `:511-514`                                                                      | `addServiceTargetOptions(cmd)`                                    |
| `rebuild` | `:526-529`                                                                      | `addServiceTargetOptions(cmd)`                                    |
| `delete`  | `:551-554`                                                                      | `addServiceTargetOptions(cmd)`                                    |
| `prune`   | `:568-571`                                                                      | `addServiceTargetOptions(cmd)`                                    |
| `plan`    | `:585-588`                                                                      | `addServiceTargetOptions(cmd)`                                    |
| `lint`    | `:631-634`                                                                      | `addServiceTargetOptions(cmd)`                                    |

**REPLACE, DO NOT APPEND.** Verified in this tree: Commander throws `Cannot add option '-s, --service <n>' … due to conflicting flag '--service'` at registration time, which kills every `rfapps` invocation.

**`status` OPTS OUT of `-g` and `--no-sidecars`** — verified: it has no group flag, no sidecar handling, and no `-p/--profile`; blanket application would grant it flags it structurally cannot honor.

Preserve the existing option **description strings** and **relative ordering** exactly — `actions/completion.spec.ts` asserts exact per-command option-set equality, and a reordering or reworded description compounds T19's work in the next batch.

**`--tag` is NOT added to** `drift show` / `rollback` (single-service `.requiredOption`), `history` (its `-s` at `:677` is a SQL filter, never a target), or any non-targeting command.

**2. Register the tag command group.** `import { registerTagCommand } from "./commands/tag.js";` and call `registerTagCommand(program);` inside the **alphabetically ordered** registrar block at `:393-400` — insert between `registerStateCommand(program);` and `registerUpdateCommand(program);`. _(`registerDriftCommand` at `:625` and `registerHardenCommand` at `:660` are outside that block; do not move them.)_

**3. preAction hook (`:152-352`).** Dispatch `validateTagShowOptions` / `validateTagSuggestOptions` (exported from `./commands/tag.js`) when `parentName === "tag"`, following the existing `validateHardenOptions` / `validateBackupCreateOptions` precedent. **ALSO pre-parse the `--tag` pattern syntax here** (call `parseTagTerm` from `./lib/tags/tag-pattern.js` on each occurrence and let it throw `InvalidArgumentError`) so a malformed pattern fails **before** the global state lock is acquired at `:348-351`.

**4. Selector site 3 (`:260-263`, the deploy `--staged` preflight).** Replace the three inline lines operating on raw `actionCommand.opts()` (verified: `deployOpts["service"] !== undefined || deployOpts["services"] !== undefined || deployOpts["group"] !== undefined`) with `hasExplicitSelector(deployOpts)` from `./lib/selector.js`. `SelectorFlags.services` accepts `string | readonly string[]` precisely so this raw-Commander site typechecks honestly. Note the **deliberate behavior change**: `--services ""` is now treated as **ABSENT** (it splits to zero names, so treating it as a target is a latent bug that today suppresses this very preflight for a selector resolving to nothing).

**5. `resolveStateLockOperation` (`:82-123`) — NO CODE CHANGE.** Its default branch already returns `undefined`, which is correct for a read-only command. Add a comment recording (a) that `rfapps tag` is read-only and must **never** take the global state lock, and (b) that the check runs on the **bare** subcommand name after only the `drift`/`state` parent branches, so a future `tag` subcommand named `apply`, `build`, `delete`, `deploy`, `prune`, `pull`, `rebuild`, `rollback`, or `stop` would silently acquire the lock.

**Traps.**

- No `[]` default and no throwing argParser on `--tag` — the collector lives in `command-options.ts` and must not be re-declared inline with a default here.
- **`src/actions/completion.spec.ts` WILL GO RED** for deploy (`:558`), rebuild (`:562`) and plan (`:581`) — those three extractors spawn the real `cli.ts` for their Commander side. **Expected (§1.4), T19-owned, repaired in batch 8. Do not touch `completion.ts` or `completion.spec.ts`.**
- Do not touch `src/mcp/`. Do not reorder the existing registrar calls. `.js` extensions on all imports.
- §1.2 cardinal rule. _(§1.6's concurrency clause is moot — you are alone in this batch, so every typecheck error is yours.)_

**doneWhen.**

- `cd $WT && npm run typecheck --workspace packages/rfapps-cli` exits 0
- `cd $WT && npm run rfapps -- tag list --help` prints `Usage:` and `Global Options:`
- `cd $WT && npm run rfapps -- deploy --help` shows `--tag <pattern>`
- `cd $WT && npm run rfapps -- status --help` shows `--tag` but **NOT** `-g, --group` or `--no-sidecars`
- `cd $WT && npm run rfapps -- history --help` and `... rollback --help` and `... drift show --help` show **no** `--tag`
- `cd $WT && npm run rfapps -- deploy --tag 'net*' --dry-run; echo $?` prints `2` with an `InvalidArgumentError` (**not** a bare Commander `process.exit(1)` bypass)
- `cd $WT/packages/rfapps-cli && umask 022 && env -u FORCE_COLOR npx vitest run src/commands --exclude '**/completion.spec.ts'` passes
- `resolveStateLockOperation`'s body is unchanged apart from added comments
- `cd $WT && git status --short packages/rfapps-cli/src/actions/completion.ts packages/rfapps-cli/src/actions/completion.spec.ts` is empty

---

### BATCH 8 — Completion repair + the CLI-spawning spec suites

_The flag surface froze at the end of B7, so completion parity can finally be reconciled and every spec that spawns the real `cli.ts` can finally assert on `--tag`. Three disjoint file sets; nobody edits production code except T19._

---

#### T19 — Shell completion for `--tag` and the `tag` command across bash, zsh, and fish

**Owned files (all write):**

- `packages/rfapps-cli/src/actions/completion.ts` (1678 lines today — **edited IN PLACE**)
- `packages/rfapps-cli/src/actions/completion.spec.ts` (784 lines today)

**Read-only context:** `packages/rfapps-cli/src/lib/tags/tag-inference-rules.ts` (T06), `packages/rfapps-cli/src/lib/hardening-rules.ts:321` (`HARDEN_RULE_IDS`), `packages/rfapps-cli/src/commands/tag.ts` (T12's option surface).

**Design sections:** §9.6, §6.1, §13.7, §13.8

**Brief.**

**MO-2 applies here.** Edit `src/actions/completion.ts` **IN PLACE**. **Do NOT split it into per-shell modules** — the design's PR A (`actions/completion/{index,bash,zsh,fish}.ts`) is explicitly **not** being done in this PR; the file is already 1678 lines and will grow, and that is accepted. **Ignore every §9.6 reference to `completion/index.ts`, `completion/bash.ts`, `completion/zsh.ts`, and `completion/fish.ts` and apply those changes to the corresponding sections of the single file. Create no files under `src/actions/completion/`.**

**THE SEVEN FAILURES YOU ARE HERE TO CLEAR.** `completion.spec.ts` is currently red — planned, not a regression (§1.4). You are the designated repair:

| assertion            | line   | Commander side now has `--tag` because |
| -------------------- | ------ | -------------------------------------- |
| backup create parity | `:438` | T15 → `commands/backup.ts`             |
| reconcile parity     | `:529` | T18 → `commands/reconcile.ts`          |
| harden parity        | `:602` | T18 → `commands/harden.ts`             |
| import parity        | `:621` | T18 → `commands/import.ts`             |
| deploy parity        | `:558` | T17 → `cli.ts`                         |
| rebuild parity       | `:562` | T17 → `cli.ts`                         |
| plan parity          | `:581` | T17 → `cli.ts`                         |

All seven must be green when you finish, **with the assertions unchanged** — you fix the generated scripts, not the assertions.

**Value derivation (top of file, beside `const hardenRuleIds = HARDEN_RULE_IDS.join(" ")` at `:30`).** Derive `tagValues` from `config.tags?.mapping` as **`Object.values(mapping).flat()` PLUS ANCESTOR CLOSURE, sorted and deduped**. **NOT `Object.keys`** — that yields **service names** and would offer them as tag completions (§13.7). Also derive `tagRuleIds` from `TAG_INFERENCE_RULE_IDS.join(" ")`. `executeCompletion` calls only `loadConfig()`; **Docker calls and `initializeDatabase()` are FORBIDDEN** in this path.

**IMPORT TAG HELPERS BY DIRECT PATH** — `../lib/tags/tag-inference-rules.js` and, if you need ancestor closure, `../lib/tags/tag-path.js`. **Do NOT import `../lib/tags/index.js` or `../lib/index.js`.** Verified: `completion.spec.ts:28` does `vi.mock("../lib/config.js", () => ({ loadConfig: vi.fn() }))` — a **partial factory**. The `lib/tags` barrel re-exports `tag-index.ts`, which imports `listConfigLayerPaths` from `../config.js`; reaching it through the barrel makes the mock throw _"No `listConfigLayerPaths` export is defined on the mock"_ at import time. If you genuinely need ancestor closure and importing `tag-path.js` is awkward, inline a five-line prefix expansion instead.

**bash section** (`generateBashCompletion`, starts `:33`):

- add `tag` to the `local commands="…"` list (**verified at `:48`**) and `|tag` to the command-detection alternation (`~:186`);
- add a nested-subcommand branch mirroring the existing `drift`/`state` handling (`~:188-203`);
- add `local tag_list_opts` / `tag_show_opts` / `tag_suggest_opts` matching §6.1's option table exactly;
- append `--tag` to all 21 `*_opts` strings;
- add `local tags="${tagValues}"` and `local tag_rules="${tagRuleIds}"`;
- **add `--tag` to BOTH the value-taking flag list at `~:158` AND the `--flag=*` alternation at `~:161`.** **Corrected rationale:** the design (and the earlier plan draft) claim this is needed "else `rfapps deploy --tag media <TAB>` misparses". **That is inaccurate.** Verified: that `case "$word" in` block lives inside `__rfapps_find_backup_subcommand` (`completion.ts:146-178`), which runs **only when `cmd == "backup"`** (`:202`). The edit is still **required** — for `rfapps backup --tag x verify <TAB>` — but do not go hunting for a global value-flag parser; there isn't one. The zsh/fish counterparts are `__rfapps_find_backup_cmd` and `__rfapps_seen_backup_verify` (`~:1177-1187`), and `getBackupVerifyClassifier` (`completion.spec.ts:293-341`) asserts on those lines, so **make the edit consistently in all three shells**;
- add a `--tag)` arm to the `case "$prev"` dispatcher with **comma-segment handling copied from `__rfapps_service_completion`'s `${cur%,*}` / `${cur##*,}` idiom (`~:220-227`)** — `--tag` is comma-separated, and a plain `compgen -W` arm gives wrong completions;
- add a `--rule)` value arm for `tag suggest` offering `${tagRuleIds}`, mirroring the `hardenRuleIds` arm — **PLAN ADDITION**: without it, `tagRuleIds` is derived and never interpolated, and `rfapps tag suggest --rule <TAB>` completes nothing;
- add a `tag)` arm to the final `case "$cmd" in`. **CORRECTED INDENTATION — verified with `cat -A`: bash final-case arms use SIX-space `arm)` and EIGHT-space `;;`** (six leading spaces, then `status)` at `:344`, `backup)` at `:383`, `drift)`, `state)`). Match the neighbours. _(The earlier plan draft said 8/10 here; that is the zsh top-level rule, not bash's.)_

**zsh section:**

- add `'tag:Inspect hierarchical service tags'` to the description array (`~:507-536`);
- add `|tag` to `__rfapps_find_command` (`~:558`);
- add `'--tag[Narrow targets by tag pattern]:tag:_values -s , tag ${tagValues}'` to each of the 21 commands (`_values -s ,` gives comma-separated completion — the `hardenRuleIds` idiom at `~:948`);
- add a `--rule` value spec for `tag suggest` offering `${tagRuleIds}`;
- **CORRECTED INDENTATION — verified against the parity regexes.** The **TOP-LEVEL** `tag)` arm is **8-space `tag)` / 10-space `;;`**: `getCommandCompletionOptions` builds `new RegExp("\\n        ${command}\\)\\n([\\s\\S]*?)\\n          ;;")` (`completion.spec.ts:207-209`) — eight spaces, ten spaces. The **NESTED** `list)` / `show)` / `suggest)` arms inside it are **16-space / 18-space**, matching `/\n {16}rebuild\)\n([\s\S]*?)\n {18};;/` (`completion.spec.ts:163`) and the load-bearing comment at `:161-162`. Emit **both** levels correctly.

**fish section:**

- `complete -c rfapps -n "__fish_use_subcommand" -a "tag"`;
- per-option `complete` lines with `-xa "(__rfapps_complete_tags)"`, plus a `--rule` line offering the tag rule ids;
- a `__rfapps_complete_tags` helper handling comma segments like `__rfapps_complete_services_list` (`~:1135-1154`);
- **`tag show` MUST be guarded with `and not __fish_seen_subcommand_from drift`, AND the reciprocal `and not __fish_seen_subcommand_from tag` MUST be added to the existing `drift show` lines.** `__fish_seen_subcommand_from X` matches token `X` **anywhere** on the line and `show` is already taken by `drift show`. `list` and `suggest` are new tokens (verified absent from the file).

**Template escaping:** these are JS template literals. Every runtime shell `$` is written `\$` and every literal backslash `\\`. `${profiles}`, `${groups}`, `${services}`, `${hardenRuleIds}`, `${tagValues}`, `${tagRuleIds}` are the **only** intentional interpolations.

**`completion.spec.ts` edits.** Add `"tag"` to the command list (`~:372-394`); add `--tag` to the required-token list (`~:680-702`); add a `tag`-arm parity extractor for all three shells — **it must use the same regex shape as the existing `getCommandCompletionOptions` (`:203-214`), not a bespoke one that rationalizes whatever indentation you happened to emit**; give `mockConfig` (`~:43-64`) a `tags` key; and add an **EMPTY-INTERPOLATION GUARD** `expect(script, shell).toContain("media/streaming")` mirroring the `harden-no-new-privileges` guard at `~:605`. **That literal guard is the ONLY way to detect an empty `${tagValues}`** — option-name parity assertions are structurally blind to it. Add the same style of guard for `${tagRuleIds}` (`expect(script, shell).toContain("tag-infer-ingress")`).

**Do not weaken, reword, or delete any existing assertion.**

**Traps.** §1.2 cardinal rule; §1.6 typecheck discipline. Do not edit `cli.ts` or any registrar — if a parity assertion cannot be satisfied because the Commander surface itself is wrong, **report it**; do not fix it here.

**doneWhen.**

- `cd $WT && npm run typecheck --workspace packages/rfapps-cli` exits 0
- `cd $WT/packages/rfapps-cli && umask 022 && env -u FORCE_COLOR npx vitest run src/actions/completion.spec.ts` passes — **all seven previously-red parity assertions green, every pre-existing assertion still present**
- `cd $WT && npx tsx packages/rfapps-cli/src/cli.ts completion --shell bash | bash -n /dev/stdin` succeeds _(use `npx tsx`, not `npm run rfapps` — the latter prints an `npm` banner on stdout that `bash -n` only tolerates by accident)_
- The generated bash script contains `--tag` in **both** the value-taking flag list and the `--flag=*` alternation, and its `tag)` final-case arm is 6-space / 8-space
- The generated zsh script's **top-level** `tag)` arm is 8-space / 10-space and its **nested** subcommand arms are 16-space / 18-space
- The generated fish script contains `tag show … and not __fish_seen_subcommand_from drift` **AND** `drift show … and not __fish_seen_subcommand_from tag`
- `tagValues` is derived with `Object.values(...).flat()` plus ancestor closure — `cd $WT && ! grep -q 'Object.keys' <(sed -n '25,40p' packages/rfapps-cli/src/actions/completion.ts)`
- `${tagRuleIds}` is interpolated into all three scripts and pinned by a literal guard
- `cd $WT && ! grep -qE 'lib/tags/index\.js|from "\.\./lib/index\.js"' packages/rfapps-cli/src/actions/completion.ts`
- `ls packages/rfapps-cli/src/actions/completion/ 2>&1` reports "No such file or directory"

---

#### T20 — `registerTagCommand` registration + lazy-load smoke spec

**Owned files:** `packages/rfapps-cli/src/commands/tag.spec.ts` (new) — write

**Read-only context:** `packages/rfapps-cli/src/commands/state.spec.ts` (**the exact template — read it first; verified `spawnSync` idiom at `:18`**), `packages/rfapps-cli/src/commands/tag.ts` (T12).

**Design sections:** §6.1, §11

**Brief.**

Create `packages/rfapps-cli/src/commands/tag.spec.ts`, copying the **mandatory 2-test shape** established by `commands/state.spec.ts`.

**Test 1 — registration smoke test, spawning the REAL CLI.** Resolve `../cli.ts` via `fileURLToPath(new URL("../cli.ts", import.meta.url))` and `spawnSync(process.execPath, ["--import", "tsx", cliPath, "tag", "list", "--help"], { encoding: "utf8" })`. Assert `result.status === 0` (pass `result.stderr` as the assertion message), and that stdout contains `Usage: rfapps tag list [options]`, **every** flag from §6.1's `tag list` row (`--tree`, `--compose`, `--env-file`, `--profile`, `--json`), and **`Global Options:`** — that last one proves `.configureHelp({ showGlobalOptions: true })` was chained on the parent **before** the subcommands were created. Repeat for `tag suggest --help`, asserting `-s/--service`, `--services`, `-g/--group`, `--rule`, `--list-rules`, `--include-tagged`, `-o/--out`, `--json`.

**Test 2 — lazy-load assertion.** Build a `new Command().name("rfapps").exitOverride()`, call `registerTagCommand(program, injectedDependencies)` where every action loader is a `vi.fn()`, then call `helpInformation()` on the `tag` command **and on each of its subcommands**, and assert **no** injected loader was called. This mechanically enforces the dynamic-import invariant that keeps CLI startup fast.

**Traps.**

1. The spec MUST live under `packages/rfapps-cli/src/` — a spec under `packages/rfapps-cli/test/` **never runs**.
2. `vi.clearAllMocks()`, never `resetAllMocks`.
3. **Do NOT create a `cli.tag.integration.spec.ts`** — there is no Docker I/O on this surface and this help smoke test covers the Commander wiring (§11 "Deliberately NOT tested").
4. Do not modify `commands/tag.ts`, `cli.ts`, or `commands/state.spec.ts` — all owned by other tasks (`cli.ts` is frozen after B7). **If the help output does not match, report the mismatch rather than editing them** (§1.2).
5. §1.6 typecheck discipline.

**doneWhen.**

- `cd $WT/packages/rfapps-cli && umask 022 && env -u FORCE_COLOR npx vitest run src/commands/tag.spec.ts` passes
- Both tests exist: the spawned-CLI help assertion and the loaders-never-called assertion
- The spawned help-output assertion includes `Global Options:`
- `cd $WT && git status --short` shows only `packages/rfapps-cli/src/commands/tag.spec.ts` as this task's change

---

#### T24 — `status --tag` CLI integration spec (+ the eight root integration specs, reserved)

**Owned files:**

| file                                                                 | mode     |
| -------------------------------------------------------------------- | -------- |
| `packages/rfapps-cli/src/cli.status.integration.spec.ts`             | write    |
| `packages/rfapps-cli/src/cli.backup.integration.spec.ts`             | reserved |
| `packages/rfapps-cli/src/cli.deploy.integration.spec.ts`             | reserved |
| `packages/rfapps-cli/src/cli.stop-plan.integration.spec.ts`          | reserved |
| `packages/rfapps-cli/src/cli.state-rebuild.integration.spec.ts`      | reserved |
| `packages/rfapps-cli/src/managed-update.integration.spec.ts`         | reserved |
| `packages/rfapps-cli/src/managed-update.compose.integration.spec.ts` | reserved |
| `packages/rfapps-cli/src/reconcile.integration.spec.ts`              | reserved |
| `packages/rfapps-cli/src/reconcile.compose.integration.spec.ts`      | reserved |

> The eight `reserved` files exercise T15's `commands/backup.ts` / `commands/update.ts` / `actions/reconcile.ts` and T17's `cli.ts`. They are expected to need **no** change, but they are assigned here so that (a) a needed fix has an unambiguous owner, and (b) T23 has an id to escalate to. **This task runs after `cli.ts` freezes**, which is the only point at which they can be repaired safely.

**Read-only context:** `packages/rfapps-cli/src/testing/cli-harness.ts` (**FROZEN** — use its `FixtureProjectOptions.configYaml` full-replacement knob, verified at `:23-25` and consumed at `:118`), `packages/rfapps-cli/src/testing/mock-docker.ts` (frozen), `packages/rfapps-cli/src/actions/status.ts` (T16).

**Design sections:** §7.9, §11

**Brief.**

`src/cli.status.integration.spec.ts` (8.3 KB today) **spawns the real `src/cli.ts` via tsx** through `runCli` (verified: file header and `cli-harness.ts:192`). It therefore cannot assert on `status --tag` until `--tag` is declared on the `status` command in `cli.ts` — which happened in **T17, batch 7**. That is why this spec is here and not with T16 in batch 5.

Add two cases:

1. **`status --tag <pattern>` filters `docker ps` rows by service key and exits 0 with valid JSON.**
2. **`status --tag <no-match>` exits 2.**

Supply the `tags:` taxonomy through the harness's **`FixtureProjectOptions.configYaml` full-replacement option** — **do NOT edit `cli-harness.ts`**; it is shared and its `DEFAULT_FIXTURE_CONFIG_YAML` must keep satisfying only the four required config sections. Your replacement YAML must itself satisfy those four required sections (`sidecars.mapping`, `groups`, `profiles.mapping`, `profiles.validProfiles`) **plus** a `tags:` block whose service keys exist in the fixture compose file.

**Pin `envTool: none`** if the spec writes an env file — CI has no dotenvx.

Then run the eight reserved specs. If any is red, **first determine whether it is red for a reason inside your write set.** If not, report the failure and the owning task id from §3; do not patch across the boundary (§1.2).

**Traps.**

1. Do not modify `cli-harness.ts`, `mock-docker.ts`, `cli.ts`, or `actions/status.ts`.
2. `vi.clearAllMocks()`, never `resetAllMocks`.
3. §1.2 cardinal rule; §1.6 typecheck discipline.

**doneWhen.**

- `cd $WT/packages/rfapps-cli && umask 022 && env -u FORCE_COLOR npx vitest run src/cli.status.integration.spec.ts` passes with both new cases
- `cd $WT/packages/rfapps-cli && umask 022 && env -u FORCE_COLOR npx vitest run src/cli.backup.integration.spec.ts src/cli.deploy.integration.spec.ts src/cli.stop-plan.integration.spec.ts src/cli.state-rebuild.integration.spec.ts src/managed-update.integration.spec.ts src/managed-update.compose.integration.spec.ts src/reconcile.integration.spec.ts src/reconcile.compose.integration.spec.ts` passes
- `cd $WT && git status --short packages/rfapps-cli/src/testing/ packages/rfapps-cli/src/cli.ts` is empty

---

### BATCH 9 — Documentation, repo deliverables, and follow-up issues

_All code is frozen, so documentation is written against real output. Two disjoint sets: T21 owns the operator-facing surface; T22 owns repo-root and agent-facing deliverables, the design/plan pair (including making `design.md` pass the repo's own gates), and the three follow-up GitHub issues._

---

#### T21 — Operator documentation: new tag-selector contract + 9 existing doc surfaces

**Owned files (all write):**

- `docs/features/rfapps-tag-selector.md` (new)
- `docs/README.md`
- `docs/features/quick-reference.md`
- `docs/features/json-output.md`
- `docs/features/output-formats.md`
- `docs/features/error-handling.md`
- `docs/features/rfapps-configuration.md`
- `docs/features/rfapps-mcp-server.md`
- `docs/features/shell-completion.md`
- `packages/rfapps-cli/README.md`

**Read-only context:** `docs/features/rfapps-harden-command.md` (the skeleton to follow), the design doc, the shipped code from B1–B8.

**Design sections:** §9.8, §3.6, §3.7, §6.5, §6.6, §7.1, §8.2, §8.4

**Brief.**

Ten documentation surfaces. **Docs ship in the SAME PR as code** — `.github/workflows/rfapps-cli.yml` is path-filtered, so a docs-only PR gets zero CI runs.

**1. NEW `docs/features/rfapps-tag-selector.md`** — the operator contract, following the `docs/features/rfapps-harden-command.md` skeleton (read it first). Required structure: H1; a negative-space lead (_"never writes compose.yml, never writes the state database, never writes configuration, never takes the global state lock"_); `## Selector Algebra` (the §7.1 equations); `## Tag Path Grammar` (§3.1/§3.2); `## Glob Semantics` (the §3.6 pattern→matches table **VERBATIM**); `## Common Surprises`; `## Command Syntax` (text usage block + option table + annotated bash from §6.4); rejected-combination prose with exit codes; `## Inference Rule Catalog` (the §8.2 table); `## Machine Result Contract` (the three §6.5 JSON envelopes); `## Exit Codes` (the §6.6 table, **with the plan-resolved correction: `--out` on an existing target exits 2 via `InvalidArgumentError`, matching `actions/harden.ts`**); `## Limitations`; `## Related Documentation` linking `../../packages/rfapps-cli/README.md#tag`, `output-formats.md`, `json-output.md`, `error-handling.md`.

`## Limitations` MUST state, honestly and without overclaiming:
(a) issue #63's literal `--tag "infrastructure/*"` is **REJECTED** and becomes `--tag infrastructure`, with the §3.7 reason;
(b) the derived identity `X ≡ X/**`;
(c) `--tag "!media/**"` selects **untagged** services too and is **not** the complement of `--tag "**"` — write `--tag "**" --tag "!media/**"` for "tagged, but not media";
(d) `tags:` in a higher config layer **WHOLLY SHADOWS** the base taxonomy (§5.4);
(e) `status --output json` returns objects with an unrelated `tag` field meaning **image tag**;
(f) `status --tag` filters on the service-key fallback, so a `container_name` differing from the service key is not matched;
(g) `--services ""` is now treated as absent;
(h) **v1 is READ-ONLY** — there is no `rfapps tag set/add/remove`, and `tag suggest` produces a paste-ready fragment instead;
(i) a day-one taxonomy does not exist, so `--tag` throws until one is authored — run `rfapps tag suggest`.

Also state §8.4's **honest note**: the two config-only inference rules largely re-encode `profiles.mapping` (45/45) and `groups` (43/45); the genuinely new value is the **cross-cutting facets** (`tag-infer-ingress` on 26 services, `tag-infer-tailnet` on 5, `tag-infer-database`/`tag-infer-cache` on 5 datastores spanning 3 groups) that `groups:` structurally cannot express.

**2. `docs/README.md`** — register the bullet under `### Feature Documentation` → `**CLI Features:**` (~`:48-68`).
**3. `packages/rfapps-cli/README.md`** — add a `### tag` section under `## Commands` (~`:199`) as the anchor target the feature doc links to, plus `--tag` rows in every affected option table.
**4. `docs/features/quick-reference.md`** — a `### Tag Selectors` cheat sheet near `:5`.
**5. `docs/features/shell-completion.md`** — add `tag` to the **hardcoded command-name comment block** at ~`:114-123` (it goes silently stale otherwise) and add `### Tag Completion Behavior` and `### Tag Values` sections mirroring `### Harden Rule Ids` at ~`:452`. Include the `tag suggest --rule` value completion.
**6. `docs/features/json-output.md`** — a `### tag Command` section with all three envelopes (`TagListResult`, `TagShowResult`, `TagSuggestResult`), each carrying `"schemaVersion": "tags.v1"`.
**7. `docs/features/output-formats.md`** — `### Tag List Table` (the flattened `tag | depth | services | count` view) plus the `--output csv` **REJECTION**.
**8. `docs/features/error-handling.md`** — exit semantics at ~`:29`, `:104`, `:126`, `:320`: a `### Tag Selector Exit Semantics` block, a sample `TagSelectorEmptyError` message (**both** §9.5 shapes), and the error category row.
**9. `docs/features/rfapps-configuration.md`** — the `tags:` section in `### Complete Example` (~`:24`) and `### Optional Fields` (~`:130`), **with the wholesale-replacement shadowing hazard stated LOUDLY**. Mandatory for any new config section.
**10. `docs/features/rfapps-mcp-server.md`** — record that tags are **deliberately CLI-only**, matching how the harden/lint/audit/doctor exclusions are documented.

**Traps.**

- markdownlint: **every heading surrounded by a blank line**; the repo runs `npm run lint:md`.
- Format your files: `cd $WT && npx prettier --write <your files>`. _(Root `npm run format` is bare `prettier --write` with no path argument and will error without one; `npm run format:all` / `npm run format:md` take paths internally.)_ `npm run format:check` is a repo gate.
- **Do NOT document a `tag set/add/remove` command; v1 is read-only.**
- Do **not** edit `ROADMAP.md`, `rfapps.config.yaml`, `packages/rfapps-cli/CLAUDE.md`, `packages/rfapps-cli/AGENTS.md`, or anything under `docs/plans/` — **T22 owns them**.
- §1.2 cardinal rule.

**doneWhen.**

- `cd $WT && npx prettier --check <your ten files>` passes
- `cd $WT && npm run lint:md` reports **no errors in any file you own** _(errors under `docs/plans/` are T22's, running concurrently — report, do not fix)_
- `docs/features/rfapps-tag-selector.md` contains the §3.6 table verbatim and all nine `## Limitations` items
- The README `### tag` anchor resolves from the feature doc's Related Documentation link
- `docs/features/shell-completion.md`'s hardcoded command-name comment block includes `tag`

---

#### T22 — ROADMAP, config template, CLAUDE.md/AGENTS.md architecture, the design/plan pair, and three follow-up issues

**Owned files (all write):**

- `ROADMAP.md`
- `rfapps.config.yaml`
- `packages/rfapps-cli/CLAUDE.md`
- `packages/rfapps-cli/AGENTS.md`
- `docs/plans/63-hierarchical-tag-selector/plan.md` (new)
- `docs/plans/63-hierarchical-tag-selector/design.md` — **FORMATTING-ONLY (PLAN REPAIR, see below)**

**Read-only context:** `.github/ISSUE_TEMPLATE/{enhancement,chore,bug}.yml`, the repo's existing label taxonomy.

**Design sections:** §9.8, §9.7, §2, §7.2, §13.1, §13.2, §13.13

**Brief.**

**0. `design.md` — formatting only, and it is MANDATORY (PLAN REPAIR).**

The design document was declared frozen by the earlier plan draft. **That was unshippable, and it is measured:**

```
$ npm run lint:md   → Summary: 2 error(s)
  docs/plans/63-hierarchical-tag-selector/design.md:77     MD032/blanks-around-lists
  docs/plans/63-hierarchical-tag-selector/design.md:1454   MD047/single-trailing-newline
$ npx prettier --check docs/plans/63-hierarchical-tag-selector/design.md
  [warn] docs/plans/63-hierarchical-tag-selector/design.md ... Code style issues found
```

`npm run lint:md` and `npm run format:check` are gates for T21, T22 **and T23**, so with `design.md` frozen no task could satisfy its own gate. **Run exactly this:**

```bash
cd $WT && npx prettier --write docs/plans/63-hierarchical-tag-selector/design.md
```

**Verified in this tree:** that single command fixes **both** markdownlint errors and the prettier failure (a prettified copy linted clean under the repo's own `.markdownlint-cli2.jsonc`). It reformats markdown-table cell padding and normalizes embedded code fences (e.g. prettier adds a trailing `;` to two `ts` sample lines). **That is acceptable and expected.** What is **not** acceptable is any change to a prose sentence, a table cell's _value_, or a normative rule. Verify by eye on `git diff` after staging, or with a word-stream comparison that ignores table separator rows.

**`git add` the pair.** `docs/plans/63-hierarchical-tag-selector/` is currently **UNTRACKED** (`git status --short` → `?? docs/plans/63-hierarchical-tag-selector/`), so `git diff` reports nothing for it and any "is design.md unchanged" assertion is vacuous. **You must `git add docs/plans/63-hierarchical-tag-selector/design.md docs/plans/63-hierarchical-tag-selector/plan.md`** — design §9.8 requires the tracked design/plan pair to ship in this PR, and no other task is assigned to stage them.

**1. `rfapps.config.yaml`** — add a **COMMENTED-OUT** `tags:` template block after the `harden:` section (verified: `# harden:` at `:183`), mirroring how the inactive `scan:` and `harden:` blocks are documented. Use the §5.1 example (traefik, authentik-server, plex, sonarr, radarr, sabnzbd, immich-server) and include the guidance comment: **store LEAF paths only — ancestors are derived automatically.** **This file is NOT in `.prettierignore` and IS covered by `npm run format:check`**, so the block must be prettier-clean. **Zero behavior change:** everything stays commented out.

**2. `ROADMAP.md` (~`:78`, `:123`)** — mark #63 **DELIVERED**; record that #62 (Smart Service Groups) extends `SelectorFlags` + `hasExplicitSelector` in `src/lib/selector.ts` rather than inventing a parallel mechanism (#62 becomes: add `smartGroup?` to `SelectorFlags` and `ServiceTargetOptions`, add one clause to `hasExplicitSelector`, implement the criteria evaluator, decide widening-vs-narrowing — everything else is already done); and record the three filed follow-ups with their issue numbers.

**3. `packages/rfapps-cli/CLAUDE.md`** — add a `### Tag Selector Architecture` section in the style of the existing `### Compose Hardening Architecture` / `### Image Vulnerability Scanning Architecture` sections: a call-chain block plus an `Invariants:` list covering **P1–P6** from §7.2, the never-create-the-MCP-key rule, no-state-lock, read-only-in-v1, the non-throwing Commander collector, trailing-`/*`-rejected, **and the plan-added structural guard** (_"the tag axis is computed inside `if (rawOptions.tag !== undefined && rawOptions.tag.length > 0)`; `getTagIndex` and `parseComposeFile` must never be reachable when `--tag` is absent, and a spy test in `interactive-selection.spec.ts` proves it"_). End with a pointer to `docs/features/rfapps-tag-selector.md`.

The MCP invariant must be recorded **verbatim in substance** (§9.7):

> The MCP adapters build raw CLI option objects literally and **must never create a `tag` key** — not even set to `undefined`. The rule is "never create the key", not "never populate it". Additionally, there is **no config-level default tag filter**: `--tag` is always explicit CLI input, so an MCP `rfapps.plan` / `rfapps.deploy` call can never be silently narrowed — the exact hazard already recorded for `ScanConfig`.

**4. `packages/rfapps-cli/AGENTS.md`** — add the **same** section. It is a near-mirror of `CLAUDE.md` and already carries the architecture sections; omitting it makes the two drift further.

**5. NEW `docs/plans/63-hierarchical-tag-selector/plan.md`** — the tracked plan half of the design/plan pair the last four features each shipped. Record:

- the batched execution plan actually followed (10 batches);
- **the two maintainer overrides** (read-only v1 is approved and this PR **CLOSES #63**; ONE PR rather than the four in §13.2, with `actions/completion.ts` edited **IN PLACE** and **NOT** split);
- **the five plan-resolved design gaps**: (i) `TagSelectorEmptyError`'s fifth constructor parameter `unresolvedServices`; (ii) `listConfigLayerPaths`; (iii) the `--out` EEXIST exit-code conflict resolved toward the `harden` precedent (exit 2); (iv) **the §7.4 tag-axis guard** — the design computes `getTagIndex()` / `parseComposeFile()` as argument expressions, which silently breaks its own P1, so the plan wraps them in `if (rawOptions.tag !== undefined && rawOptions.tag.length > 0)`; (v) `buildTagIndex` takes the compose universe as a **parameter** so `lib/validation.ts` ↔ `lib/tags/tag-index.ts` never form an import cycle;
- **the deliberately-red window**: `src/actions/completion.spec.ts`'s seven exact-parity assertions are red from batch 6 until T19 lands in batch 8, and the B6/B7 barrier gates exclude that file on purpose;
- the three follow-up issue numbers.

Commit message prefix for everything under `docs/plans/` is `docs(internal): …`.

**6. File THREE follow-up GitHub issues** using the repo's YAML forms under `.github/ISSUE_TEMPLATE/` — **never title-only, never template-bypass.** If `gh issue create --template` fails on the YAML forms, create via the GitHub API/MCP with a body mirroring the form fields, then apply the correct labels from the repo's existing taxonomy (**do not invent labels**):

**(a) `[rfapps-cli] rfapps tag set/remove — config writer`** (enhancement). Body carries the §13.1 forward design: resolve the target layer as _"the highest-precedence config file that already declares `tags:`, else the project base `rfapps.config.yaml`"_ — never defaulting to `.rfapps.yaml`, which would create a shadowing layer by accident; read **raw file text** (never serialize the loaded `RfappsConfig`, which has `injectSecrets`-resolved `{{ VAR }}` templates and host-absolute `composePath`/`envFile` baked in); parse with `parseDocument`; **ASSERT `doc.toString({ lineWidth: 0, flowCollectionPadding: false }) === source` on the UNMODIFIED document and refuse otherwise** (a runtime invariant, not a one-time measurement); detect and preserve source indentation; `setIn(["tags","mapping",service], seq)`; verify the output is prettier-clean; write atomically (temp + chmod original mode + rename); still **no** global state lock; last-writer-wins across concurrent invocations, documented. **Note that `listConfigLayerPaths()` — the layer-discovery primitive §13.1 says does not exist — was added by this PR in `src/lib/config.ts`, so the writer no longer needs to build it.**

**(b) `[rfapps-cli] split shell completion generators into per-shell modules`** (refactor/chore). Body: pure move of `src/actions/completion.ts` (now >1678 lines) into `src/actions/completion/{index,bash,zsh,fish}.ts`; **ZERO behavior change**; fully pinned by the existing parity suite in `src/actions/completion.spec.ts` unchanged. Note it was deliberately deferred so the #63 PR would not carry a ~3400-line mechanical diff.

**(c) `[rfapps-cli] --profile silently no-ops against a profile-less compose file`** (bug). Body from §13.13: `compose.yml` declares **no** `profiles:` keys, so `rfapps deploy -p media` passes `--profile media` to a profile-less compose file and Compose targets **everything** while the operator believes they scoped it. Fixing it means either making `-p` a real targeting flag backed by `config.profiles.mapping` (changing the meaning of an existing flag across 12 commands and the MCP surface) or rejecting `-p` when compose declares no profiles (a behavior change on every existing invocation) — both deserve their own design and review. Explicitly out of scope for #63.

After filing, write the three issue numbers into `ROADMAP.md` **and** `docs/plans/63-hierarchical-tag-selector/plan.md`.

**Traps.**

- markdownlint — blank line around every heading.
- Format your files (`npx prettier --write …`); `rfapps.config.yaml` is format-gated.
- **The maintainer has CONFIRMED read-only v1 and the PR body says `Closes #63`** — do **NOT** write `Refs #63` anywhere, and do **not** reproduce §13.1's "no PR claims `Closes #63` without confirmation" hedge; it is **RESOLVED**.
- Do not touch any file under `docs/features/` or `packages/rfapps-cli/README.md` — **T21 owns them**, and it is running concurrently.
- **Change `design.md`'s FORMATTING ONLY.** Its content is authoritative.
- §1.2 cardinal rule.

**doneWhen.**

- `cd $WT && npm run format:check` passes _(covers `rfapps.config.yaml` **and** `design.md`)_
- `cd $WT && npm run lint:md` reports **zero errors** — in particular, the two pre-existing `design.md` errors (`:77` MD032, `:1454` MD047) are gone
- `cd $WT && npm run rfapps -- validate` still succeeds with the commented-out `tags:` block present (zero behavior change)
- `cd $WT && git status --short docs/plans/63-hierarchical-tag-selector/` shows both `design.md` and `plan.md` as **staged (porcelain status column `A`)**, not `??`
- `design.md`'s prose, table cell values, and normative rules are unchanged — only whitespace, table padding, and code-fence normalization differ
- Three GitHub issues exist, each created from a `.github/ISSUE_TEMPLATE/` form with repo-taxonomy labels, and their numbers appear in `ROADMAP.md` and `plan.md`
- `packages/rfapps-cli/CLAUDE.md` **and** `AGENTS.md` both contain a `### Tag Selector Architecture` section with the never-create-the-MCP-key invariant and the §7.4 guard invariant
- `docs/plans/63-hierarchical-tag-selector/plan.md` records **both** maintainer overrides, **all five** plan-resolved design gaps, and the deliberately-red completion window

---

### BATCH 10 — Verification gate

---

#### T23 — Full CI-parity verification gate

**Owned files:** _(none — write-light by design)_
**Sole authorized write:** a formatting-only rewrite via `npx prettier --write <failing paths>` **if and only if** the `format:check` gate fails. T23 is alone in its batch specifically so this repo-wide operation cannot race another agent.

**Design sections:** §11

**Brief.**

Run the complete gate suite against the **worktree using ABSOLUTE PATHS ONLY**. The main checkout at `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps` sits at the same HEAD, so any relative-path or `cd`-less command passes **VACUOUSLY AGAINST THE WRONG TREE**.

Run in this order and record pass/fail plus actual counts for the PR's `## Testing` block. Gate commands are enumerated in §5.3.

**CORRECTED baseline — measured in THIS worktree at `c54b647b`, not quoted:**

```
Test Files  109 passed | 2 skipped (111)
     Tests  1566 passed | 2 skipped (1568)
  Duration  ~20.7s
```

**`format:check` and `lint:md` were DIRTY at baseline, in exactly one file.** The earlier draft claimed "clean; the 16 pre-existing errors are all under `.claude/worktrees/**/research/**`" — **that is false and verified false**: `.markdownlint-cli2.jsonc` lists `research` in `ignores`, and the **only two** errors across all 659 linted files were `docs/plans/63-hierarchical-tag-selector/design.md:77` (MD032) and `:1454` (MD047), with `prettier --check` also failing on that same file. **T22 fixed both in batch 9.** So at T23 time the correct expectation is: **`lint:md` → 0 errors, `format:check` → clean.** If either is dirty, T22 under-delivered.

**Corrections to naive gate invocations (verified against `package.json`):**

| Wrong                                      | Right                                                   | Why                                                                                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run format`                           | `npx prettier --write <paths>`                          | root `format` is bare `prettier --write` with **no path**; it errors without an argument                                                                                                               |
| `npm test --workspace packages/rfapps-cli` | `npm run test:coverage --workspace packages/rfapps-cli` | the package-level `test` script is bare `vitest` (**watch mode — hangs**)                                                                                                                              |
| `npm test` at root                         | _(safe)_                                                | root `test` → `test:run` → `bash scripts/test-run.sh`, which applies `umask 022` and unsets `FORCE_COLOR` internally                                                                                   |
| `graphify update .` in the worktree        | run it in the **main checkout after merge**             | verified: `graphify-out/` does **not exist** in this worktree (it is gitignored and lives only in the main checkout); running it here creates a stray untracked directory and refreshes nothing useful |

**Spot-check these behaviors by hand and report the observed output:**

```bash
cd $WT && npm run rfapps -- tag list                                  # exits 0 on empty taxonomy, stderr points to `tag suggest`
cd $WT && npm run rfapps -- deploy --tag 'infrastructure/*' --dry-run # exits 2 with the corrective "use 'infrastructure'" suggestion
cd $WT && npm run rfapps -- update --from-plan /nonexistent.json      # does NOT throw a selector-conflict error (no-[]-default regression)
cd $WT && npm run rfapps -- backup --all --tag 'x'                    # exits 2 with the mutual-exclusion error
cd $WT && npm run rfapps -- deploy --dry-run                          # no --tag: behaves exactly as before #63
cd $WT && npm run rfapps -- status --help                             # shows --tag but NOT -g / --no-sidecars
cd $WT && npm run rfapps -- drift show --help                         # shows NO --tag
```

**FAILURE ESCALATION — read this, it is the part the earlier draft left undefined.**

For **any** failure other than formatting, do **NOT** patch the offending file. Report the failing gate, the exact command, the error output, and the **owning task id** from §3. Because every owning batch has already closed by the time you run, use this routing table:

| symptom                                                                    | route to                                                | note                                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/actions/completion.spec.ts` parity red                                | **T19** (batch 8)                                       | the seven assertions in §1.4 are T19's contract; if any is still red, T19 under-delivered |
| `src/commands/reconcile.spec.ts:42` array mismatch                         | **T18** (batch 6)                                       | T18 owns both `commands/reconcile.ts` and that spec                                       |
| a root `*.integration.spec.ts` red                                         | **T24** (batch 8)                                       | T24 owns all nine as `write`/`reserved`                                                   |
| `format:check` dirty                                                       | **fix it yourself** — this is your one authorized write | `npx prettier --write <paths>`                                                            |
| `lint:md` errors under `docs/plans/`                                       | **T22** (batch 9)                                       |                                                                                           |
| `lint:md` errors under `docs/features/` or `packages/rfapps-cli/README.md` | **T21** (batch 9)                                       |                                                                                           |
| typecheck error                                                            | grep §3 for the file                                    |                                                                                           |

If a route lands on a closed batch, the orchestrator re-opens that single task; **you do not fix it.** That is the escalation path, and it exists because a barrier-gate failure discovered after its owning batch has closed has no other owner.

**doneWhen.**

- All seven gate commands in §5.3 exit 0, each invoked with an absolute `cd $WT` prefix
- `npm run test:coverage --workspace packages/rfapps-cli` reports a test count **strictly greater than the 1566 baseline** with zero failures and zero regressions in the 111 baseline files
- `npm run lint:md` produces **zero** errors (the two baseline `design.md` errors were fixed by T22)
- `npm run format:check` passes
- All seven hand spot-checks produce the documented behavior, with observed output recorded
- A pass/fail table with exact commands is produced for the PR `## Testing` section

---

## 3. Master file-ownership table

**This is the conflict-prevention contract. Every file appears exactly once. `write` = the task must change it. `reserved` = the task owns it so a needed fix has an owner; no change expected.**

| file                                                                                                                                | task    | batch | mode                                    |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------- | ----- | --------------------------------------- |
| `packages/rfapps-cli/src/types/tags.ts`                                                                                             | T01     | 1     | write                                   |
| `packages/rfapps-cli/src/types/options.ts`                                                                                          | T01     | 1     | write                                   |
| `packages/rfapps-cli/src/types/config.ts`                                                                                           | T01     | 1     | write                                   |
| `packages/rfapps-cli/src/types/index.ts`                                                                                            | T01     | 1     | write                                   |
| `packages/rfapps-cli/src/types/options.spec.ts`                                                                                     | T01     | 1     | reserved                                |
| `packages/rfapps-cli/src/lib/errors.ts`                                                                                             | T02     | 1     | write                                   |
| `packages/rfapps-cli/src/lib/error-formatters.ts`                                                                                   | T02     | 1     | write                                   |
| `packages/rfapps-cli/src/lib/errors.spec.ts`                                                                                        | T02     | 1     | write                                   |
| `packages/rfapps-cli/src/lib/error-formatters.spec.ts`                                                                              | T02     | 1     | write                                   |
| `packages/rfapps-cli/src/lib/error-formatters-registration.spec.ts`                                                                 | T02     | 1     | reserved                                |
| `packages/rfapps-cli/src/lib/command-options.ts`                                                                                    | T03     | 1     | write                                   |
| `packages/rfapps-cli/src/lib/tags/tag-path.ts`                                                                                      | T04     | 2     | write                                   |
| `packages/rfapps-cli/src/lib/tags/tag-pattern.ts`                                                                                   | T04     | 2     | write                                   |
| `packages/rfapps-cli/src/lib/tags/tag-path.spec.ts`                                                                                 | T04     | 2     | write                                   |
| `packages/rfapps-cli/src/lib/tags/tag-pattern.spec.ts`                                                                              | T04     | 2     | write                                   |
| `packages/rfapps-cli/src/lib/tags/tag-suggestions.ts`                                                                               | T05     | 2     | write                                   |
| `packages/rfapps-cli/src/lib/tags/tag-inference-rules.ts`                                                                           | T06     | 2     | write                                   |
| `packages/rfapps-cli/src/lib/config.ts`                                                                                             | T07     | 2     | write                                   |
| `packages/rfapps-cli/src/lib/config.test.ts`                                                                                        | T07     | 2     | write                                   |
| `packages/rfapps-cli/src/lib/tags/tag-index.ts`                                                                                     | T08     | 3     | write                                   |
| `packages/rfapps-cli/src/lib/tags/tag-index.spec.ts`                                                                                | T08     | 3     | write                                   |
| `packages/rfapps-cli/src/lib/selector.ts`                                                                                           | T09     | 3     | write                                   |
| `packages/rfapps-cli/src/lib/selector.spec.ts`                                                                                      | T09     | 3     | write                                   |
| `packages/rfapps-cli/src/lib/tags/tag-inference.ts`                                                                                 | T10     | 3     | write                                   |
| `packages/rfapps-cli/src/lib/tags/tag-inference.spec.ts`                                                                            | T10     | 3     | write                                   |
| `packages/rfapps-cli/src/lib/validation.ts`                                                                                         | T11     | 4     | write                                   |
| `packages/rfapps-cli/src/lib/index.ts`                                                                                              | T11     | 4     | write                                   |
| `packages/rfapps-cli/src/lib/tags/index.ts`                                                                                         | T11     | 4     | write                                   |
| `packages/rfapps-cli/src/lib/validation.spec.ts`                                                                                    | T11     | 4     | reserved                                |
| `packages/rfapps-cli/src/commands/tag.ts`                                                                                           | T12     | 4     | write                                   |
| `packages/rfapps-cli/src/actions/tag.ts`                                                                                            | T12     | 4     | write                                   |
| `packages/rfapps-cli/src/actions/tag-suggest.ts`                                                                                    | T12     | 4     | write                                   |
| `packages/rfapps-cli/src/actions/tag.spec.ts`                                                                                       | T12     | 4     | write                                   |
| `packages/rfapps-cli/src/actions/tag-suggest.spec.ts`                                                                               | T12     | 4     | write                                   |
| `packages/rfapps-cli/src/lib/interactive-selection.ts`                                                                              | T13     | 4     | write                                   |
| `packages/rfapps-cli/src/lib/interactive-check.ts`                                                                                  | T13     | 4     | write                                   |
| `packages/rfapps-cli/src/lib/interactive-selection.spec.ts`                                                                         | T13     | 4     | write                                   |
| `packages/rfapps-cli/src/lib/interactive-check.spec.ts`                                                                             | T13     | 4     | write                                   |
| `packages/rfapps-cli/src/actions/health.ts`                                                                                         | T14     | 5     | write                                   |
| `packages/rfapps-cli/src/actions/deploy.ts`                                                                                         | T14     | 5     | write                                   |
| `packages/rfapps-cli/src/actions/rebuild.ts`                                                                                        | T14     | 5     | write                                   |
| `packages/rfapps-cli/src/actions/pull.ts`                                                                                           | T14     | 5     | write                                   |
| `packages/rfapps-cli/src/actions/stop.ts`                                                                                           | T14     | 5     | write                                   |
| `packages/rfapps-cli/src/actions/build.ts`                                                                                          | T14     | 5     | write                                   |
| `packages/rfapps-cli/src/actions/audit.ts`                                                                                          | T14     | 5     | write                                   |
| `packages/rfapps-cli/src/actions/delete.ts`                                                                                         | T14     | 5     | write                                   |
| `packages/rfapps-cli/src/actions/import.ts`                                                                                         | T14     | 5     | write                                   |
| `packages/rfapps-cli/src/actions/harden.ts`                                                                                         | T14     | 5     | write                                   |
| `packages/rfapps-cli/src/actions/doctor.ts`                                                                                         | T14     | 5     | write                                   |
| `packages/rfapps-cli/src/actions/plan.ts`                                                                                           | T14     | 5     | write                                   |
| `packages/rfapps-cli/src/actions/lint.ts`                                                                                           | T14     | 5     | write                                   |
| `packages/rfapps-cli/src/actions/prune.ts`                                                                                          | T14     | 5     | write                                   |
| `packages/rfapps-cli/src/actions/drift.ts`                                                                                          | T14     | 5     | write                                   |
| `packages/rfapps-cli/src/actions/{deploy,rebuild,pull,stop,audit,delete,import,harden,doctor,plan,lint,prune,drift,health}.spec.ts` | T14     | 5     | reserved                                |
| `packages/rfapps-cli/src/actions/status.ts`                                                                                         | T16     | 5     | write                                   |
| `packages/rfapps-cli/src/actions/status.spec.ts`                                                                                    | T16     | 5     | write                                   |
| `packages/rfapps-cli/src/actions/backup.ts`                                                                                         | T15     | 6     | write                                   |
| `packages/rfapps-cli/src/actions/reconcile.ts`                                                                                      | T15     | 6     | write                                   |
| `packages/rfapps-cli/src/actions/update.ts`                                                                                         | T15     | 6     | write                                   |
| `packages/rfapps-cli/src/commands/backup.ts`                                                                                        | T15     | 6     | write                                   |
| `packages/rfapps-cli/src/commands/update.ts`                                                                                        | T15     | 6     | write                                   |
| `packages/rfapps-cli/src/commands/backup.spec.ts`                                                                                   | T15     | 6     | write                                   |
| `packages/rfapps-cli/src/commands/update.spec.ts`                                                                                   | T15     | 6     | write                                   |
| `packages/rfapps-cli/src/actions/reconcile.spec.ts`                                                                                 | T15     | 6     | write                                   |
| `packages/rfapps-cli/src/actions/backup.spec.ts`                                                                                    | T15     | 6     | reserved                                |
| `packages/rfapps-cli/src/actions/update.spec.ts`                                                                                    | T15     | 6     | reserved                                |
| `packages/rfapps-cli/src/commands/audit.ts`                                                                                         | T18     | 6     | write                                   |
| `packages/rfapps-cli/src/commands/doctor.ts`                                                                                        | T18     | 6     | write                                   |
| `packages/rfapps-cli/src/commands/drift.ts`                                                                                         | T18     | 6     | write                                   |
| `packages/rfapps-cli/src/commands/harden.ts`                                                                                        | T18     | 6     | write                                   |
| `packages/rfapps-cli/src/commands/import.ts`                                                                                        | T18     | 6     | write                                   |
| `packages/rfapps-cli/src/commands/reconcile.ts`                                                                                     | T18     | 6     | write                                   |
| **`packages/rfapps-cli/src/commands/reconcile.spec.ts`**                                                                            | **T18** | **6** | **write — REASSIGNED from T15**         |
| `packages/rfapps-cli/src/commands/{audit,doctor,drift,harden,import}.spec.ts`                                                       | T18     | 6     | reserved                                |
| `packages/rfapps-cli/src/cli.ts`                                                                                                    | T17     | 7     | write                                   |
| `packages/rfapps-cli/src/actions/completion.ts`                                                                                     | T19     | 8     | write                                   |
| `packages/rfapps-cli/src/actions/completion.spec.ts`                                                                                | T19     | 8     | write                                   |
| `packages/rfapps-cli/src/commands/tag.spec.ts`                                                                                      | T20     | 8     | write                                   |
| `packages/rfapps-cli/src/cli.status.integration.spec.ts`                                                                            | T24     | 8     | write                                   |
| `packages/rfapps-cli/src/cli.backup.integration.spec.ts`                                                                            | T24     | 8     | reserved                                |
| `packages/rfapps-cli/src/cli.deploy.integration.spec.ts`                                                                            | T24     | 8     | reserved                                |
| `packages/rfapps-cli/src/cli.stop-plan.integration.spec.ts`                                                                         | T24     | 8     | reserved                                |
| `packages/rfapps-cli/src/cli.state-rebuild.integration.spec.ts`                                                                     | T24     | 8     | reserved                                |
| `packages/rfapps-cli/src/managed-update.integration.spec.ts`                                                                        | T24     | 8     | reserved                                |
| `packages/rfapps-cli/src/managed-update.compose.integration.spec.ts`                                                                | T24     | 8     | reserved                                |
| `packages/rfapps-cli/src/reconcile.integration.spec.ts`                                                                             | T24     | 8     | reserved                                |
| `packages/rfapps-cli/src/reconcile.compose.integration.spec.ts`                                                                     | T24     | 8     | reserved                                |
| `docs/features/rfapps-tag-selector.md`                                                                                              | T21     | 9     | write                                   |
| `docs/README.md`                                                                                                                    | T21     | 9     | write                                   |
| `docs/features/quick-reference.md`                                                                                                  | T21     | 9     | write                                   |
| `docs/features/json-output.md`                                                                                                      | T21     | 9     | write                                   |
| `docs/features/output-formats.md`                                                                                                   | T21     | 9     | write                                   |
| `docs/features/error-handling.md`                                                                                                   | T21     | 9     | write                                   |
| `docs/features/rfapps-configuration.md`                                                                                             | T21     | 9     | write                                   |
| `docs/features/rfapps-mcp-server.md`                                                                                                | T21     | 9     | write                                   |
| `docs/features/shell-completion.md`                                                                                                 | T21     | 9     | write                                   |
| `packages/rfapps-cli/README.md`                                                                                                     | T21     | 9     | write                                   |
| `ROADMAP.md`                                                                                                                        | T22     | 9     | write                                   |
| `rfapps.config.yaml`                                                                                                                | T22     | 9     | write                                   |
| `packages/rfapps-cli/CLAUDE.md`                                                                                                     | T22     | 9     | write                                   |
| `packages/rfapps-cli/AGENTS.md`                                                                                                     | T22     | 9     | write                                   |
| `docs/plans/63-hierarchical-tag-selector/plan.md`                                                                                   | T22     | 9     | write                                   |
| **`docs/plans/63-hierarchical-tag-selector/design.md`**                                                                             | **T22** | **9** | **write — FORMATTING ONLY + `git add`** |

### Deliberately unowned and FROZEN

Pinned by `doneWhen` assertions; they appear in **no** task's write or reserved set:

`packages/rfapps-cli/src/mcp/**` · `packages/rfapps-cli/src/testing/cli-harness.ts` · `packages/rfapps-cli/src/testing/mock-docker.ts` · `packages/rfapps-cli/src/lib/exit-codes.ts` · `packages/rfapps-cli/src/lib/docker.ts` · `packages/rfapps-cli/src/lib/fuzzy-match.ts` · `packages/rfapps-cli/src/lib/hardening-rules.ts` · `packages/rfapps-cli/src/lib/interactive.tsx` · `packages/rfapps-cli/src/commands/state.spec.ts` · `packages/rfapps-cli/src/actions/completion/` (must not be created)

---

## 4. Cross-batch shared files and ordering

**No file is written by two tasks anywhere in this plan.** Every high-fan-out shared file has exactly one owner:

| high-fan-out file                                                    | sole owner | batch | why one owner is achievable                                                                                                                            |
| -------------------------------------------------------------------- | ---------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/cli.ts`                                                         | T17        | 7     | All five `cli.ts` concerns are bundled into one task, in a batch of its own.                                                                           |
| `src/actions/completion.ts` + `.spec.ts`                             | T19        | 8     | MO-2 forbids the split; all three shell sections plus value derivation plus the seven parity repairs land in one task, after the flag surface freezes. |
| `src/lib/config.ts`                                                  | T07        | 2     | Both merge branches **and** `listConfigLayerPaths` are one task; T08 and T11 consume it read-only later.                                               |
| `src/types/{options,config,index}.ts` + `tags.ts`                    | T01        | 1     | All type edits are one task, so the type surface is frozen before any consumer exists.                                                                 |
| `src/lib/index.ts`                                                   | T11        | 4     | Nothing in B1–B3 imports through the barrel (all imports are direct paths), so the single barrel edit can wait until B4.                               |
| `src/lib/interactive-selection.ts`                                   | T13        | 4     | The exported DI type and the tag branch are one task; T15 consumes the type read-only in B6.                                                           |
| `src/lib/validation.ts`                                              | T11        | 4     | Both new validators plus the two call sites are one task.                                                                                              |
| `src/lib/errors.ts`, `error-formatters.ts`                           | T02        | 1     | Class, formatter, and both specs in one task; T13 constructs it read-only in B4.                                                                       |
| `src/lib/interactive-check.ts`                                       | T13        | 4     | Bundled with the resolver — both are selector-predicate replacements with a shared correctness story.                                                  |
| `src/commands/backup.ts`, `update.ts` (+ their specs)                | T15        | 6     | Conflict lists, selector sites, **and** `--tag` declaration in one task, so T18 must not touch them.                                                   |
| `src/commands/reconcile.ts` **and** `src/commands/reconcile.spec.ts` | T18        | 6     | Reassigned to one owner: whoever declares the flag must fix the ordered array that pins its position.                                                  |

**Ordering requirements (each is a real import or runtime edge):**

1. **T01 (B1) before everything.** `tag?: string[]` on `ServiceTargetOptions` and the `tags.ts` types must exist or every later batch fails `tsc`.
2. **T07 (B2) before T08 and T11.** `listConfigLayerPaths` feeds `TagIndex.source` and `validateTagLayerOwnership`.
3. **T04 (B2) before T08, T09, T10, T17.** The grammar is imported by the index, the selector, the engine, and the `cli.ts` preAction pre-parse.
4. **T08 + T09 + T02 (B1/B3) before T13 (B4).** The resolver imports `hasExplicitSelector`, `applyTagAxis`, `getTagIndex`, `findClosestTag`, and `TagSelectorEmptyError`.
5. **T13 (B4) before T15 (B6).** `ResolveServicesFn` must exist before three DI seams reference it.
6. **T03 (B1) before T15 + T18 (B6) and T17 (B7).** `addServiceTargetOptions` is the flag-declaration helper.
7. **T12 (B4) before T17 (B7) and T20 (B8).** `registerTagCommand` and the two validators must exist before `cli.ts` imports them and before the spawned-CLI smoke test runs.
8. **T15 + T18 (B6) before T17 (B7).** _(New edge, defect 5.)_ `cli.ts:393-400`, `:625`, `:660` statically import every registrar T18/T15 edit, so T17's `--help` gates require those files finished. Co-batching produced a mutual deadlock.
9. **T16 (B5) + T17 (B7) before T24 (B8).** _(New edge, defect 6.)_ `cli.status.integration.spec.ts` spawns the real `cli.ts`; `--tag` is not declared on `status` until T17.
10. **T15 (B6), T18 (B6) and T17 (B7) before T19 (B8).** _(Two new edges, defects 1/7/10.)_ Completion's parity extractors assert **exact per-command option-set equality**, so they go red the moment a flag lands and can only be reconciled once the surface is frozen. This is the single most important barrier in the plan, and §1.4 documents the deliberately-red window it creates.
11. **All code (B1–B8) before T21 + T22 (B9).** Docs are written against real, observed CLI output.
12. **Everything before T23 (B10).**

---

## 5. Verification gates

`WT=/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-feat-63-tagging` — **expand literally; never shorten.**

### 5.1 Per-task gate (run by each agent before declaring done)

```bash
cd $WT && npm run typecheck --workspace packages/rfapps-cli     # §1.6 discipline applies
cd $WT/packages/rfapps-cli && umask 022 && env -u FORCE_COLOR npx vitest run <ONLY the task's OWNED spec files>
```

**Per-task test gates are scoped to owned files, never to a directory glob.** A glob such as `src/lib`, `src/actions`, or `src/commands` sweeps in specs a same-batch sibling is mid-edit on, producing red gates the agent has no authority to fix and pressure to edit across the ownership boundary. Directory globs live only in §5.2.

### 5.2 Barrier gate (run at the end of each batch, before the next starts)

| after batch | command                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1          | `cd $WT && npm run typecheck --workspace packages/rfapps-cli`                                                                                                                                                                                                                                                                                                                                                           |
| B2          | typecheck **and** `cd $WT/packages/rfapps-cli && umask 022 && env -u FORCE_COLOR npx vitest run src/lib/tags src/lib/config.test.ts`                                                                                                                                                                                                                                                                                    |
| B3          | typecheck **and** `… npx vitest run src/lib`                                                                                                                                                                                                                                                                                                                                                                            |
| B4          | typecheck **and** `… npx vitest run src/lib src/commands src/actions/tag.spec.ts src/actions/tag-suggest.spec.ts`                                                                                                                                                                                                                                                                                                       |
| B5          | typecheck **and** `… npx vitest run src/actions` _(full glob — completion parity is still GREEN here)_                                                                                                                                                                                                                                                                                                                  |
| **B6**      | typecheck **and** `… npx vitest run src/actions src/commands --exclude '**/completion.spec.ts'` **and** `cd $WT && for c in audit doctor harden import reconcile backup update "drift detect" "drift reconcile" "drift import"; do npm run rfapps -- $c --help \| grep -q -- '--tag <pattern>' \|\| echo "MISSING: $c"; done` (prints nothing) **and** `cd $WT && npm run rfapps -- drift show --help` shows no `--tag` |
| **B7**      | typecheck **and** `… npx vitest run --exclude '**/completion.spec.ts'` (whole package) **and** `cd $WT && npm run rfapps -- tag list --help && npm run rfapps -- deploy --help && npm run rfapps -- status --help`                                                                                                                                                                                                      |
| **B8**      | `cd $WT/packages/rfapps-cli && umask 022 && env -u FORCE_COLOR npx vitest run` — **full package suite, NO exclusions.** This is the reconciliation point for §1.4's expected-red window.                                                                                                                                                                                                                                |
| B9          | `cd $WT && npm run format:check && npm run lint:md`                                                                                                                                                                                                                                                                                                                                                                     |

**B6 and B7 exclude `src/actions/completion.spec.ts` by design** (§1.4). `--exclude` is verified working in this tree.

### 5.3 Final gate (T23, batch 10)

**CI parity — the actual merge gate:**

```bash
cd $WT && npm run typecheck --workspace packages/rfapps-cli
cd $WT && umask 022 && env -u FORCE_COLOR npm run test:coverage --workspace packages/rfapps-cli
```

**Repo-policy gates (paste results into the PR `## Testing` block):**

```bash
cd $WT && npm run format:check
cd $WT && npm run typecheck                 # all three workspaces
cd $WT && npm run lint:md
cd $WT && npm run test:run                  # pre-push hook parity; applies umask 022 + unsets FORCE_COLOR internally
```

**Baseline to beat (measured in this worktree at `c54b647b`):** `109 test files passed / 2 skipped (111)`, `1566 tests passed / 2 skipped (1568)`, ~20.7 s. **`format:check` and `lint:md` were DIRTY at baseline in exactly one file — `docs/plans/63-hierarchical-tag-selector/design.md` (MD032 `:77`, MD047 `:1454`, plus a prettier failure). T22 fixes it in B9, so at T23 both gates must be CLEAN.**

**Conditional repair (T23 only, alone in its batch):** if `format:check` fails, `cd $WT && npx prettier --write <the failing paths>` — a formatting-only rewrite. **Root `npm run format` is bare `prettier --write` with no path argument and will error without one.** For any non-formatting failure, T23 follows the escalation routing table in its brief; it does not patch.

**Post-merge, in the MAIN checkout (not the worktree):** `cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps && graphify update .` — verified: `graphify-out/` does not exist in the worktree.

**Never run:** `npm test --workspace packages/rfapps-cli` or bare `npx vitest` — both are watch mode and hang. Root `npm test` is safe (it delegates to `scripts/test-run.sh`).

---

## 6. Deliverables checklist — mapped 1:1 to design §9

### §9.1 New files (13 planned)

| design path                                           | task | batch | status                                                                                   |
| ----------------------------------------------------- | ---- | ----- | ---------------------------------------------------------------------------------------- |
| `src/types/tags.ts`                                   | T01  | 1     | ✅                                                                                       |
| `src/lib/tags/tag-path.ts`                            | T04  | 2     | ✅                                                                                       |
| `src/lib/tags/tag-pattern.ts`                         | T04  | 2     | ✅                                                                                       |
| `src/lib/tags/tag-index.ts`                           | T08  | 3     | ✅ (signature changed: `universe` is a parameter — kills the validation↔tag-index cycle) |
| `src/lib/tags/tag-suggestions.ts`                     | T05  | 2     | ✅                                                                                       |
| `src/lib/tags/tag-inference-rules.ts`                 | T06  | 2     | ✅                                                                                       |
| `src/lib/tags/tag-inference.ts`                       | T10  | 3     | ✅                                                                                       |
| `src/lib/tags/index.ts`                               | T11  | 4     | ✅                                                                                       |
| `src/lib/selector.ts`                                 | T09  | 3     | ✅                                                                                       |
| `src/lib/command-options.ts`                          | T03  | 1     | ✅                                                                                       |
| `src/commands/tag.ts`                                 | T12  | 4     | ✅ (read-only surface only — **MO-1**)                                                   |
| `src/actions/tag.ts`                                  | T12  | 4     | ✅                                                                                       |
| `src/actions/tag-suggest.ts`                          | T12  | 4     | ✅                                                                                       |
| ~~`src/actions/completion/{index,bash,zsh,fish}.ts`~~ | —    | —     | ❌ **NOT CREATED — MO-2.** Filed as follow-up (b) by T22.                                |

### §9.2 Modified — types and config

| design item                                                                                                             | task | status                                            |
| ----------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------- |
| `types/options.ts` — `tag?: string[]` on `ServiceTargetOptions`                                                         | T01  | ✅                                                |
| `types/config.ts` — `tags?: TagConfig` / `tags: Partial<TagConfig>`                                                     | T01  | ✅                                                |
| `types/index.ts` — re-export `tags.js`                                                                                  | T01  | ✅                                                |
| `lib/config.ts` — `mergeConfig` + `partialToFull` `tags` branches, **not** a required field                             | T07  | ✅ (throw list stays at 4, asserted)              |
| **PLAN ADDITION** — `lib/config.ts` `listConfigLayerPaths()`                                                            | T07  | ✅ closes the §13.1 layer-discovery gap           |
| `lib/index.ts` — re-export `selector.js`, `command-options.js`, `tags/index.js`                                         | T11  | ✅                                                |
| `lib/validation.ts` — `validateTagReferences` + `validateTagLayerOwnership`, called from `validateConfigAgainstCompose` | T11  | ✅ warning severity only, non-throwing (asserted) |

### §9.3 Modified — the targeting pipeline

| design item                                                                                                                                                          | task            | status                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------- |
| `interactive-selection.ts` — export `ResolveServicesSelection` + `ResolveServicesFn`                                                                                 | T13             | ✅                                                                                                  |
| `interactive-selection.ts` — selector site 1                                                                                                                         | T13             | ✅                                                                                                  |
| `interactive-selection.ts` — tag branch, `validateServiceNames` before the intersection                                                                              | T13             | ✅ P2/P3/P4/P6 asserted                                                                             |
| **PLAN CORRECTION** — the tag branch is wrapped in `if (rawOptions.tag !== undefined && rawOptions.tag.length > 0)`                                                  | T13             | ✅ design §7.4's argument-expression form silently broke its own P1; spy test added                 |
| `interactive-check.ts` — selector site 2                                                                                                                             | T13             | ✅                                                                                                  |
| `cli.ts:260-263` — selector site 3                                                                                                                                   | T17             | ✅                                                                                                  |
| `actions/reconcile.ts:646-657` — selector site 4                                                                                                                     | T15             | ✅                                                                                                  |
| `commands/backup.ts:73-77` — selector site 5                                                                                                                         | T15             | ✅                                                                                                  |
| `actions/backup.ts:472-485` — selector site 6                                                                                                                        | T15             | ✅                                                                                                  |
| `commands/update.ts:23-30` — `--tag` in the `--from-plan` conflict list                                                                                              | T15             | ✅                                                                                                  |
| three DI seams reference `ResolveServicesFn`                                                                                                                         | T15             | ✅                                                                                                  |
| **16 direct resolver call sites — 31 `group:` keys** across 15 action files                                                                                          | T14             | ✅ exact per-file anchor table supplied                                                             |
| **PLAN CORRECTION** — **FIVE** `group` sites in T15's files, incl. `reconcile.ts:263` (spread idiom, invisible to the `group: rawOptions.group` grep)                | T15             | ✅ without it `reconcile --tag` and `drift reconcile --tag` silently no-op                          |
| **PLAN ADDITION** — 17 local `Raw*Options` + **`NormalizedReconcileOptions` (`reconcile.ts:79`) + `NormalizedUpdateOptions` (`update.ts:93`)** gain `tag?: string[]` | T14 / T15 / T16 | ✅ neither Normalized interface extends `ServiceTargetOptions`, so T01's fan-out never reaches them |
| `actions/status.ts` — the bespoke §7.9 path, `tagPatterns` binding                                                                                                   | T16             | ✅                                                                                                  |

### §9.4 Modified — command registration (21 command paths)

| design item                                                                | task | batch | status                                                                                                             |
| -------------------------------------------------------------------------- | ---- | ----- | ------------------------------------------------------------------------------------------------------------------ |
| 11 inline commands in `cli.ts` (`status` opts out of `-g`/`--no-sidecars`) | T17  | 7     | ✅ **replace, not append** — Commander throws on duplicates (verified)                                             |
| `commands/{audit,doctor,drift×3,harden,import,reconcile}.ts` — 8 paths     | T18  | 6     | ✅                                                                                                                 |
| `commands/{backup,update}.ts` — 2 paths                                    | T15  | 6     | ✅ `backup` uses the inline collector (its block is non-contiguous: `--all` sits between `-g` and `--no-sidecars`) |
| `registerTagCommand(program)` in the `:393-400` registrar block            | T17  | 7     | ✅                                                                                                                 |
| preAction dispatch + `--tag` pre-parse before the state lock               | T17  | 7     | ✅                                                                                                                 |
| `resolveStateLockOperation` — **comment only, no code change**             | T17  | 7     | ✅                                                                                                                 |
| **Total: 11 + 8 + 2 = 21 declared paths**                                  | —    | —     | ✅ matches §6.3                                                                                                    |

### §9.5 Errors

| design item                                                                                                                          | task                       | status                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | -------------------------------------------------------------------- |
| `TagSelectorEmptyError` in `lib/errors.ts`                                                                                           | T02                        | ✅ (16 → 17 exported classes, asserted)                              |
| Formatter import + registration with `ExitCode.UsageError`, appended as `// 16.`                                                     | T02                        | ✅ (verified: 16 existing registrations numbered 1–15 **plus `9b`**) |
| Both §9.5 message shapes (default + `unresolvedServices`)                                                                            | T02                        | ✅                                                                   |
| **PLAN-RESOLVED GAP** — optional **5th** ctor param `unresolvedServices` (default `[]`), preserving the §7.4 four-argument call site | T02 (declare) / T13 (pass) | ✅                                                                   |

### §9.6 Shell completion — all three templates

| design item                                                                                                                                                                                        | task | status                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------- |
| ~~Prerequisite PR A: split `completion.ts`~~                                                                                                                                                       | —    | ❌ **NOT DONE — MO-2.** Edited in place; filed as follow-up (b).                             |
| `tagValues` from `Object.values(...).flat()` + ancestor closure (**not `Object.keys`**)                                                                                                            | T19  | ✅                                                                                           |
| `tagRuleIds` from `TAG_INFERENCE_RULE_IDS` **and actually interpolated into a `--rule` arm in all three shells**                                                                                   | T19  | ✅ **PLAN ADDITION** — the design derived the constant but never wired it                    |
| bash: command list (`:48`), alternation, nested branch, 3 tag `*_opts`, `--tag` on 21 `*_opts`, `local tags`, both value-flag forms, comma-segment `--tag)` arm, **6-space `tag)` / 8-space `;;`** | T19  | ✅ **indentation corrected** — verified `cat -A`; the earlier draft gave zsh's rule for bash |
| zsh: description entry, `__rfapps_find_command`, `_values -s ,` on 21 commands, **8/10 top-level arm AND 16/18 nested arms**                                                                       | T19  | ✅ **both levels now stated** — verified against `completion.spec.ts:207-209` and `:163`     |
| fish: `__fish_use_subcommand`, `__rfapps_complete_tags`, **`tag show` ⇄ `drift show` reciprocal guards**                                                                                           | T19  | ✅                                                                                           |
| `completion.spec.ts` — command list, token list, 3 parity extractors (same regex shape as `getCommandCompletionOptions`), `mockConfig.tags`, **two empty-interpolation literal guards**            | T19  | ✅                                                                                           |
| **The seven exact-parity assertions that go red in B6/B7 and are repaired here**                                                                                                                   | T19  | ✅ enumerated up front in §1.4 and in T19's brief                                            |

### §9.7 MCP — deliberately NOT surfaced

| design item                                                                                         | task | status                                                                                                                                             |
| --------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `tag` key anywhere in `src/mcp/`                                                                 | —    | ✅ `src/mcp/**` is unowned; T01/T12/T14/T15/T16/T18 each carry the invariant and assert `git status --short packages/rfapps-cli/src/mcp/` is empty |
| "Never create the key, not never populate it" invariant recorded in `CLAUDE.md` **and** `AGENTS.md` | T22  | ✅                                                                                                                                                 |
| `_typeCheck` anchor stays green                                                                     | —    | ✅ pinned by the B8 full suite and T23                                                                                                             |

### §9.8 Documentation (15 surfaces)

| design surface                                                                                                                                                                      | task    | status                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/features/rfapps-tag-selector.md` (NEW)                                                                                                                                        | T21     | ✅ incl. all 9 `## Limitations` items and the §8.4 honest-value note                                                                                   |
| `docs/README.md` · `quick-reference.md` · `shell-completion.md` · `json-output.md` · `output-formats.md` · `error-handling.md` · `rfapps-configuration.md` · `rfapps-mcp-server.md` | T21     | ✅                                                                                                                                                     |
| `packages/rfapps-cli/README.md` `### tag` anchor                                                                                                                                    | T21     | ✅                                                                                                                                                     |
| `packages/rfapps-cli/CLAUDE.md` + `AGENTS.md` `### Tag Selector Architecture`                                                                                                       | T22     | ✅ incl. the P1 structural-guard invariant                                                                                                             |
| `rfapps.config.yaml` commented-out `tags:` template                                                                                                                                 | T22     | ✅ prettier-clean, zero behavior change                                                                                                                |
| `ROADMAP.md`                                                                                                                                                                        | T22     | ✅ #63 delivered; #62 seam recorded; three follow-ups numbered                                                                                         |
| `docs/plans/63-hierarchical-tag-selector/plan.md`                                                                                                                                   | T22     | ✅ `docs(internal): …`                                                                                                                                 |
| **`docs/plans/63-hierarchical-tag-selector/design.md`**                                                                                                                             | **T22** | ✅ **PLAN REPAIR** — formatting-only fix so `lint:md` + `format:check` can pass, **and both files are `git add`ed** (the directory is untracked today) |

### §10 Out-of-scope enforcement (spot-checked by `doneWhen`)

Tag mutation ❌ · any config write ❌ · compose-label storage ❌ · state-DB storage ❌ · MCP surfacing ❌ · runtime criteria ❌ · tag-aware interactive selection ❌ · trailing `/*` ❌ · partial-segment wildcards ❌ · `--tag` on `drift show`/`rollback`/`history` ❌ · `status` refactor onto the resolver ❌ · `getServiceContainerMap` bridge ❌ · deep-merge of `tags.mapping` ❌ · `RFAPPS_TAGS` env var ❌ · `tags` field on `ServiceChange`/`ServiceStatus` ❌ · `resolveTagExitCode`/`setTagExitCode` ❌ · architecture-check script ❌.

### §11 Critical tests

| design spec                                           | task    | status                                                                                                                                                                                                          |
| ----------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/tags/tag-pattern.spec.ts`                        | T04     | ✅ §3.6 table verbatim, table-driven                                                                                                                                                                            |
| `lib/tags/tag-path.spec.ts`                           | T04     | ✅                                                                                                                                                                                                              |
| `lib/tags/tag-index.spec.ts`                          | T08     | ✅ direct, not transitive                                                                                                                                                                                       |
| `lib/selector.spec.ts`                                | T09     | ✅                                                                                                                                                                                                              |
| `commands/tag.spec.ts`                                | T20     | ✅ mandatory 2-test shape                                                                                                                                                                                       |
| `lib/tags/tag-inference.spec.ts`                      | T10     | ✅ **four ENGINE behaviors** — writes-nothing, degraded mode, ingress map form, ingress list form                                                                                                               |
| **`actions/tag-suggest.spec.ts`** (NEW)               | **T12** | ✅ **PLAN ADDITION** — `executeTagSuggest` writes nothing under every mode; **`--out` on an existing file throws** (the §11 case the earlier draft dropped); local `--json` beats the global `--output` default |
| **`actions/tag.spec.ts`** (NEW)                       | **T12** | ✅ **PLAN ADDITION** — local `--json` beats the global default; `--output csv` rejected                                                                                                                         |
| `lib/interactive-selection.spec.ts` (37 existing + 6) | T13     | ✅ incl. the spy-based P1 proof                                                                                                                                                                                 |
| `lib/interactive-check.spec.ts`                       | T13     | ✅                                                                                                                                                                                                              |
| `actions/status.spec.ts`                              | T16     | ✅ **PLAN ADDITION** — the spy-based P1 proof for `status`                                                                                                                                                      |
| `actions/completion.spec.ts` (784 existing)           | T19     | ✅ incl. two empty-interpolation guards                                                                                                                                                                         |
| `commands/backup.spec.ts` · `commands/update.spec.ts` | T15     | ✅ incl. the no-`[]`-default regression case                                                                                                                                                                    |
| **`actions/reconcile.spec.ts`**                       | **T15** | ✅ **PLAN ADDITION** — `reconcile --tag` reaches `resolveServices` with non-`undefined` `tag` (proves `reconcile.ts:263` was not missed)                                                                        |
| **`commands/reconcile.spec.ts`**                      | **T18** | ✅ **PLAN REPAIR** — the ordered option array at `:42` gains `"--tag"`; reassigned so the flag-declarer owns the assertion that pins it                                                                         |
| `lib/config.test.ts`                                  | T07     | ✅                                                                                                                                                                                                              |
| `lib/errors.spec.ts` + `lib/error-formatters.spec.ts` | T02     | ✅                                                                                                                                                                                                              |
| `cli.status.integration.spec.ts`                      | **T24** | ✅ **PLAN REPAIR** — moved to batch 8; it spawns the real `cli.ts`, where `--tag` on `status` does not exist until T17 (batch 7)                                                                                |

---

## 7. PR assembly (not owned by any task)

- **Title (verbatim changelog line):** `feat(rfapps): add hierarchical tag selector for service targeting (#63)`
- **`## Related Issues`:** `Closes #63` — **MO-1 is confirmed; do not write `Refs #63`.** Also reference the three follow-up issues T22 filed: **#328** (config writer), **#329** (completion split), **#330** (`--profile` no-op). See §9.
- **`## Testing`:** paste T23's pass/fail table with exact commands and before/after counts (baseline `1566 passed / 2 skipped`, and the note that `lint:md`/`format:check` were dirty at baseline on `design.md` and are clean after).
- **`## Breaking Changes`:** the one documented behavior change — `--services ""` is now treated as **absent** by `hasExplicitSelector`, which re-enables the deploy `--staged` preflight for a selector resolving to nothing. Pinned by a test in `selector.spec.ts`.
- **`## Risk and Rollback`:** the load-bearing safety property is **P2** — a `--tag` matching nothing throws `TagSelectorEmptyError` (exit 2) and never collapses into the `services: []` "whole project" sentinel. **P1** guarantees that omitting `--tag` is structurally unreachable from the new code path, and is proven mechanically by two spy tests (`interactive-selection.spec.ts`, `status.spec.ts`).
- The `docs/plans/**` files staged by T22 are committed with a `docs(internal): …` message per repo policy.

---

## 8. Plan-resolved design gaps

`design.md` is authoritative, but five points were under- or mis-specified there and were resolved **by this plan** rather than left to per-agent judgement. Each one is implemented as written below; each is recorded here so a future reader diffing the design against the shipped code does not treat the difference as drift.

| #       | Gap in `design.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Resolution shipped                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **i**   | `TagSelectorEmptyError`'s constructor is specified with **four** parameters (`patterns`, `baseSelectors`, `knownTags`, `suggestion?`) in §4.5, but §7.2's **P4** requires the message to name stale `tags.mapping` entries. Four fields cannot carry that diagnosis.                                                                                                                                                                                                                                                                                                                               | A **fifth constructor parameter, `unresolvedServices: string[]`**, on `TagSelectorEmptyError`. When it is non-empty the formatter replaces the generic "`--tag` narrows, it does not widen" body with the specific "`tags.mapping` assigns this tag to services absent from compose.yml: …" body and suggests `rfapps validate`. Without it P4 is unimplementable.                                                  |
| **ii**  | §13.1 states that layer discovery **does not exist** (`loadConfig` discards every layer path; `findConfigFile` is module-private) and treats it as net-new work for the deferred v2 writer. But `TagIndex.source` and `validateTagLayerOwnership` both need it **in v1**.                                                                                                                                                                                                                                                                                                                          | **`listConfigLayerPaths(cwd?)` is added to `src/lib/config.ts`** in this PR, reusing `loadConfig`'s precedence order rather than duplicating it. Consequence for the follow-up: the v2 config writer no longer has to build it — recorded in issue [#328](https://github.com/yandy-r/rfmedia-apps/issues/328).                                                                                                      |
| **iii** | §6.6's exit-code table and §6.1's `tag suggest --out` contract disagree about the `EEXIST` case: `--out` opens with `flag: "wx"`, and the design does not say which exit code an already-existing target produces.                                                                                                                                                                                                                                                                                                                                                                                 | Resolved toward the **`harden` precedent**: an existing `--out` target raises `InvalidArgumentError` and exits **2** (usage error), exactly as `actions/harden.ts` does for its own `--out`. Not exit 1, not exit 3. Pinned by `actions/tag-suggest.spec.ts`.                                                                                                                                                       |
| **iv**  | **The §7.4 tag-axis guard.** The design's own snippet computes `getTagIndex(config, composePath)` and `parseComposeFile(composePath)` as **argument expressions** to `applyTagAxis`, so they evaluate on every invocation — which silently breaks the design's own **P1** ("when `--tag` is absent the new path is unreachable, not merely equivalent"). Combined with `buildTagIndex`'s `ConfigValidationError`, one malformed `tags.mapping` entry would break `rfapps deploy -s plex` on all 20 resolver-backed paths, and every invocation would newly pay a YAML parse of every config layer. | Both calls are wrapped in an explicit **`if (rawOptions.tag !== undefined && rawOptions.tag.length > 0)`** guard in `lib/interactive-selection.ts`, with the same guard on the `status` path in `actions/status.ts`. P1 becomes structural. Proven mechanically by **spy tests**: with `tag` undefined, neither `getTagIndex` nor `parseComposeFile` is called (`interactive-selection.spec.ts`, `status.spec.ts`). |
| **v**   | §4.1/§7.4 have `buildTagIndex`/`getTagIndex` obtain the compose universe themselves, which makes `lib/tags/tag-index.ts` import `lib/validation.ts` — while `lib/validation.ts` must import `lib/tags/` for `validateTagReferences`. That is an **import cycle**.                                                                                                                                                                                                                                                                                                                                  | **`buildTagIndex` and `getTagIndex` take the compose universe as a parameter.** `tag-index.ts` never imports `../validation.js`; the caller (which already has the universe) passes it. Verified `config.ts` does not import `validation.ts` either, so the chain stays acyclic. Asserted from both sides, by T08 and by T11.                                                                                       |

---

## 9. Follow-up issues filed

Filed by **T22** from the repo's `.github/ISSUE_TEMPLATE/` YAML forms (body mirroring the form fields; `gh issue create` rejects `--template` together with `--body-file`), labelled from the existing taxonomy only:

| Issue                                                      | Title                                                                 | Form / labels                                                             | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#328](https://github.com/yandy-r/rfmedia-apps/issues/328) | `[enhancement] rfapps tag set/remove — config writer`                 | enhancement · `enhancement`, `rfapps-cli`, `architecture`, `priority:low` | The §13.1 forward design for the deferred v2 writer: resolve the highest-precedence layer that already declares `tags:` (never defaulting to `.rfapps.yaml`), read raw file text, `parseDocument`, assert round-trip stability on the **unmodified** document as a runtime invariant, preserve indentation, `setIn(["tags","mapping",service], seq)`, verify prettier-clean output, write atomically, no state lock. Notes that plan-resolved gap (ii) already shipped `listConfigLayerPaths()`.                          |
| [#329](https://github.com/yandy-r/rfmedia-apps/issues/329) | `[chore] Split shell completion generators into per-shell modules`    | chore · `rfapps-cli`, `architecture`, `priority:low`                      | Design PR **A**, deferred by **MO-2**. Pure move of `src/actions/completion.ts` (grown from 1678 to **1961** lines by this PR) into `src/actions/completion/{index,bash,zsh,fish}.ts`, zero behavior change, pinned by `completion.spec.ts` unchanged. Deferred so the #63 PR would not also carry a ~3400-line mechanical diff.                                                                                                                                                                                          |
| [#330](https://github.com/yandy-r/rfmedia-apps/issues/330) | `[bug] --profile silently no-ops against a profile-less compose file` | bug · `bug`, `rfapps-cli`, `architecture`, `priority:medium`              | §13.13, re-verified in this tree: `compose.yml` contains **no `profiles:` key at all**, so `rfapps deploy -p media` forwards `--profile media` to a profile-less compose file and Compose targets everything while the operator believes it was scoped. Both candidate fixes (make `-p` a real targeting axis backed by `config.profiles.mapping`, or reject `-p` when compose declares none) are behavior changes across 12 commands and the MCP surface, so each needs its own design. Explicitly out of scope for #63. |

The same three numbers are recorded in `ROADMAP.md`, and the PR body references them alongside `Closes #63`.

---

## Validation repairs applied

All twelve blocking defects were re-verified against the real tree before repair. Eleven were confirmed; one validator's _proposed fix_ was rejected and replaced with a correct one.

### Blocking

| #                                                                  | Verdict                                                                                                                                                                                                                                                                                              | Repair                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** ownership — missing T15→T19 edge                             | **CONFIRMED** (reproduced: adding `--tag` to `commands/backup.ts` fails `completion.spec.ts:438` with `- "tag"`; tree restored)                                                                                                                                                                      | **Validator's option (a) REJECTED as wrong.** It proposed moving `commands/backup.ts`/`update.ts` out of T15 into batch 6 — but T15 must write those files anyway for selector site 5 and the `--from-plan` conflict list, and `commands/update.spec.ts`'s `--from-plan … --tag` case cannot parse `--tag` unless the same task declares it. Splitting would put one file in two tasks. **Adopted instead:** move **all of T15** to batch 6, which keeps B5 fully green, then apply option (b)'s exclusion for B6/B7. Added §1.4 (the expected-red window with the seven named assertions), scoped T14's gate to owned specs, and added ordering edge 10 in §4. |
| **2** ownership — frozen `design.md` fails the gates               | **CONFIRMED** (`lint:md` → 2 errors, both in `design.md`; `prettier --check` fails; the earlier "16 errors under research/\*\*" claim is false — `research` is in markdownlint's ignore list and there were exactly 2 errors across 659 files)                                                       | `design.md` removed from the frozen list and given to **T22 as a formatting-only owner**. **Verified fix:** `npx prettier --write` alone clears both MD032 and MD047 and the prettier failure (a prettified copy linted clean under the repo config). Added a content-preservation instruction and replaced the vacuous `git diff` assertion. Also assigned T22 to **`git add`** the pair — the directory is `??` today, so no `git diff` assertion on it means anything. §5.3's baseline corrected.                                                                                                                                                            |
| **3** ownership — gates run siblings' in-flight files              | **CONFIRMED** (`state.spec.ts:18`, `backup.spec.ts:52`, `reconcile.spec.ts:170` each `spawnSync` `../cli.ts`; `npm run rfapps` = `tsx src/cli.ts`)                                                                                                                                                   | §5.1 now mandates **owned-files-only** per-task test gates; all directory globs moved to §5.2. T18's `--help` spawns demoted to the barrier. §1.2 makes "report and wait, never edit" the cardinal rule in every brief, and §1.6 adds the same discipline for the shared typecheck.                                                                                                                                                                                                                                                                                                                                                                             |
| **4** coverage — `--out` case dropped; tag actions untested        | **CONFIRMED** (`executeTagSuggest` lives in T12's `actions/tag-suggest.ts`, unreachable from T10's batch-3 engine spec, whose own `doneWhen` forbids a write path)                                                                                                                                   | Added **`src/actions/tag-suggest.spec.ts`** (writes-nothing under every mode; `--out` EEXIST throws `InvalidArgumentError`; local `--json` beats the global default) and **`src/actions/tag.spec.ts`** (`--json` precedence; `--output csv` rejection) to **T12's write set** — same task, same batch, no ownership conflict. T10's row in §6 corrected to say "four **engine** behaviors" and to name where the `--out` case went.                                                                                                                                                                                                                             |
| **5** coverage — B6 mutual doneWhen deadlock                       | **CONFIRMED** (`cli.ts` statically imports all six T18 registrars at `:393-400`, `:625`, `:660`)                                                                                                                                                                                                     | **Validator's option (a) adopted and extended:** batch 6 = T15 + T18 (registrars), **batch 7 = T17 (`cli.ts`) alone.** This also removes the cli.ts-loads-in-flight-registrars hazard entirely. Both `--help` smokes demoted to the barrier. Ordering edge 8 added.                                                                                                                                                                                                                                                                                                                                                                                             |
| **6** dependency — T16 tests a flag that does not exist yet        | **CONFIRMED** (`cli.status.integration.spec.ts` header + `cli-harness.ts:192` spawn the real `cli.ts`; `--tag` on `status` is declared in `cli.ts`, T17-owned)                                                                                                                                       | **Validator's fix adopted:** T16 keeps `actions/status.ts` + `actions/status.spec.ts` in batch 5; the integration spec becomes **T24 in batch 8**. Removed from the B5 barrier, added to B8. Ordering edge 9 added. T24 also absorbs the eight previously-unowned root integration specs.                                                                                                                                                                                                                                                                                                                                                                       |
| **7** dependency — six parity tests break from B5                  | **CONFIRMED** (exact `.toEqual` at `:438`, `:529`, `:558`, `:562`, `:581`, `:602`, `:621` — **seven**, not six)                                                                                                                                                                                      | Same repair as defect 1. Because T15 moved to B6, the red window is **B6→B8**, not B5→B8; B5's barrier keeps the full `src/actions` glob. §1.4 names all seven and hands them to T19.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **8** dependency — `commands/reconcile.spec.ts:42` un-owned break  | **CONFIRMED** (exact ordered `toEqual` of ten long option names; T18 owns `commands/reconcile.ts`, T15 never touches it)                                                                                                                                                                             | **Reassigned `commands/reconcile.spec.ts` from T15 to T18** in §3, with the required edit spelled out (insert `"--tag"` between `"--group"` and `"--no-sidecars"`, matching the position `addServiceTargetOptions` emits) and a `doneWhen` assertion. §4's "no file written by two tasks" claim is now true again.                                                                                                                                                                                                                                                                                                                                              |
| **9** traps — missing 5th `group` site + two Normalized interfaces | **CONFIRMED** (`reconcile.ts:263` is `...(group === undefined ? {} : { group }),` — invisible to the `group: rawOptions.group` grep; `NormalizedReconcileOptions` at `:79` and `NormalizedUpdateOptions` at `:93` do **not** extend `ServiceTargetOptions`)                                          | T15's enumeration rewritten as an explicit **five-site table** with the spread idiom called out at `reconcile.ts:263`, both Normalized interfaces added to the required-edit list, a `grep -c 'tag'` assertion added, and a new `actions/reconcile.spec.ts` case proving `tag` reaches `resolveServices`.                                                                                                                                                                                                                                                                                                                                                       |
| **10** traps — B5/B6 cannot reach their gates                      | **CONFIRMED** (same experiment as defect 1)                                                                                                                                                                                                                                                          | Superseded by the defect-1/5 re-batching plus §1.4. B5 is now green; B6/B7 exclude the file explicitly; T15/T17/T18 are each told not to touch it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **11** traps — wrong completion indentation                        | **CONFIRMED** (`cat -A`: bash final-case arms are **6-space** `status)` / 8-space `;;`; `completion.spec.ts:207-209` requires **8/10** for zsh top-level; `:163` requires **16/18** for zsh nested)                                                                                                  | T19's instructions rewritten with the verified values for **all three levels**, plus a requirement that the new `tag`-arm extractor reuse `getCommandCompletionOptions`'s regex shape rather than a bespoke one that rationalizes whatever was emitted.                                                                                                                                                                                                                                                                                                                                                                                                         |
| **12** traps — §7.4 code defeats its own P1                        | **CONFIRMED** (the design passes `getTagIndex(...)`/`parseComposeFile(...)` as **argument expressions** to `applyTagAxis`, so they evaluate unconditionally; combined with T08's `ConfigValidationError`, one bad `tags.mapping` entry would break `rfapps deploy -s plex` on all 20 resolver paths) | T13's mandated block rewritten with an explicit `if (rawOptions.tag !== undefined && rawOptions.tag.length > 0)` guard and an in-source comment naming the design gap. Added a **spy-based `doneWhen`**: with `tag` undefined, neither `getTagIndex` nor `parseComposeFile` is called. Same guard + spy test mandated for T16's `status` path. Recorded as plan-resolved gap (iv) in T22's `plan.md`.                                                                                                                                                                                                                                                           |

### Non-blocking gaps absorbed

- **T13 direct-path import** — added to T13's brief (§1.3 inversion 4 now covers T12 **and** T13).
- **`actions/tag*.ts` had no spec** — resolved by defect 4's two new specs.
- **Eight un-owned root integration specs** — assigned to **T24** (batch 8, after `cli.ts` freezes), giving T23 an id to escalate to.
- **Vacuous `design.md` assertion / nobody stages the pair** — resolved by defect 2's repair; T22 now `git add`s both.
- **B6 red completion unstated** — now §1.4, plus explicit notes in T15/T17/T18.
- **`validation.spec.ts` write-vs-reserved ambiguity** — §3 now has an explicit **mode column** for every file, and §1.1 defines the two modes.
- **`tagRuleIds` derived but never interpolated** — T19 now wires a `--rule` value arm for `tag suggest` in bash, zsh **and** fish, plus a `tag-infer-ingress` literal guard.
- **"replace vs append" unstated for T17/T18** — **verified: Commander throws** `Cannot add option '-s, --service <n>' … due to conflicting flag '--service'`. Now stated in T03's doc comment and in T15/T17/T18's briefs, with the verified anchor blocks to delete.
- **Package-wide typecheck concurrency** — §1.6 adds an explicit retry-then-report discipline; the authoritative typecheck stays at the barrier.
- **`grep -c … returns 0` misreads exit 1** — every negative assertion rewritten as `! grep -q`.
- **T01 "13 named types"** — corrected to **14** (the 13 enumerated plus `TagPath`).
- **T12's un-runnable `grep -rn src/mcp/` assertion** — dropped; the `git status --short packages/rfapps-cli/src/mcp/` check covers it.
- **Stale anchors** — `completion.ts` `local commands=` corrected to **`:48`**; `cli.ts` health block corrected; every brief already says "grep, do not trust line numbers".
- **bash `:158`/`:161` rationale wrong** — corrected in T19: that block lives in `__rfapps_find_backup_subcommand` and runs only for `backup`. The edit is still required (for `backup --tag x verify`), and T19 is told to make it consistently across `__rfapps_find_backup_cmd` (zsh) and `__rfapps_seen_backup_verify` (fish) because `getBackupVerifyClassifier` asserts on those lines.
- **Fragile `npm run rfapps … | bash -n` gate** — replaced with `npx tsx packages/rfapps-cli/src/cli.ts completion --shell bash | bash -n /dev/stdin`.
- **`validation.ts` ↔ `tag-index.ts` import cycle** — eliminated by design: `buildTagIndex` and `getTagIndex` now take the compose `universe` as a **parameter**, so `tag-index.ts` never imports `../validation.js`. Verified `config.ts` does not import `validation.ts` either, so the chain stays acyclic. Asserted from both sides (T08 and T11).
- **`completion.spec.ts` partial `loadConfig` mock** — T19 is now told to import tag helpers by **direct path only**, never through `lib/tags/index.js` or `lib/index.js`, with the exact failure mode quoted.
- **`status.spec.ts` full automock ambiguity** — T16 now has a mandated strategy: reach `getTagIndex`/`applyTagAxis` **through the existing `../lib/index.js` barrel** (consistent with the rest of `status.ts`) and supply explicit `vi.mocked(...)` values; direct-path imports are forbidden because they would do real I/O in a unit spec.
- **T18 insertion position unstated** — now stated in T03 (the helper's emitted order) and T18 (the pinned array).
- **T23 escalation path for closed batches** — T23 now carries an explicit symptom→owner routing table with a re-open protocol.
- **`error-formatters.ts` "next number" ambiguity** — verified 16 registrations numbered 1–15 plus `9b`; T02 is told to append as **`// 16.`**.
- **T19 told the wrong cause of its red suite** — corrected: the `tag` registration is the minor part; the seven exact-parity failures from the `--tag` flag declarations are the real work, and they are handed to T19 as a table.
