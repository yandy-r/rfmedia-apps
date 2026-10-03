## Implementation plan — `rfapps state rebuild` (#150)

The approved design doc is `docs/plans/state-rebuild-150/design.md`. It is the specification.
Everything below either restates it operationally or **overrides** it where adversarial verification
proved a claim wrong. Where the two disagree, **this plan wins** — do not "fix" an override back to
the design doc's wording.

### Non-negotiable conventions (all code tasks)

- TypeScript strict; **never** `any` (no `as any`, no unchecked casts, no `interface{}`-style escape).
- ESM: every relative import carries a `.js` extension, even for `.ts` sources.
- `commands/` is CLI surface only (Commander wiring, option validation, help text). `actions/` is
  business logic. `lib/` is shared primitives. An action must **never** import another action.
- Action modules are lazily imported inside the command's `.action()` handler.
- Errors use the existing classes in `src/lib/errors.ts` + formatters in `src/lib/error-formatters.ts`.
  **No new error classes.**
- All human/text output goes to **stderr** via `logInfo` / `logWarn` / `logSuccess` from
  `@rfmedia/common`. Machine output goes to stdout via `formatOutput`.
- Files soft-capped at ~500 lines.
- Only the ten critical tests from the design's "Critical tests only" section. No extra tests.
- Exit codes are set with `setExitCode(...)` from `src/lib/exit-codes.js`, never a raw
  `process.exitCode = n`.

---

## Overrides from verification

Each override is authoritative. The owning task repeats it inline so implementers cannot miss it.

| #   | Design doc says                                                                                                                                                                                              | Correction (authoritative)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Owning task         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| O1  | `formatOutput` comes from `@rfmedia/common`                                                                                                                                                                  | `formatOutput` is defined in **`src/lib/formatters/index.ts`** and re-exported from **`src/lib/index.ts`**. Import it from `../lib/index.js`. Only `OutputFormat`, `isMachineFormat`, `confirm`, `logInfo`/`logWarn`/`logSuccess`/`logDebug`, `colors`, `formatError`, `outputFormattedError` come from `@rfmedia/common`.                                                                                                                                                                                                                                                                           | T7, T8              |
| O2  | `--mode <mode>` declared with `.option(...).choices([...])`                                                                                                                                                  | Commander's `.option()` returns the `Command`, not the `Option` — `.choices()` is **not** chainable there. Use `.addOption(new Option("--mode <mode>", "...").choices(["salvage","runtime-only"]).default("salvage"))`, importing `Option` from `commander`. Precedent: `src/cli.ts:117-119`, `src/commands/init.ts:28-35`.                                                                                                                                                                                                                                                                          | T9                  |
| O3  | `swapStateDatabase(tempPath, targetPath, backupPath)` (§Atomic swap) vs 2-param in the listing                                                                                                               | **Two parameters**: `swapStateDatabase(tempPath: string, targetPath: string): Promise<void>`. `backupPath` is never used by the swap algorithm.                                                                                                                                                                                                                                                                                                                                                                                                                                                      | T4, T7              |
| O4  | `carryOverState(source, target)` (§Salvage carry-over) vs 3-param in the listing                                                                                                                             | **Three parameters**: `carryOverState(source, target, generationActions)`. The exported `GENERATION_ACTIONS` set is injected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | T3, T4, T7          |
| O5  | Module plan adds `"update"` to `VALID_ACTIONS` in `src/actions/history.ts`; completion steps bash-5 / zsh-3 / fish-3 add `update` to the three `--action` value lists (`completion.ts:209`, `:639`, `:1043`) | **OUT OF SCOPE** per the lead's decision. The bug is real but unrelated to #150 and will be filed separately. **Do not touch `src/actions/history.ts`.** **Do not edit those three `--action` lists.** Rebuild writes rows with action `"import"`, which is already in `VALID_ACTIONS`.                                                                                                                                                                                                                                                                                                              | T11 (must not), all |
| O6  | `.configureHelp({ showGlobalOptions: true })` on the `state` group                                                                                                                                           | Correct, but **ordering is load-bearing**. Commander 14.0.3 copies `_helpConfiguration` into a subcommand at **creation time** (`lib/command.js:176` → `copyInheritedSettings` at `:103`). Chain `.configureHelp(...)` on the `state` group **before** `state.command("export")` / `state.command("rebuild")` are created, or test 9's `Global Options:` assertion fails.                                                                                                                                                                                                                            | T9                  |
| O7  | Call `registerStateCommand(program)` "in the modular block (lines 288-293)" alongside `registerDriftCommand`                                                                                                 | The block at `src/cli.ts:288-293` contains audit/doctor/force-unlock/import/reconcile/update in **alphabetical** order. `registerDriftCommand` is **not** there — it sits alone at `src/cli.ts:462`. Add `registerStateCommand(program);` between the `registerReconcileCommand` and `registerUpdateCommand` lines to keep it alphabetical. Add the import after `import { registerReconcileCommand } ...` (`cli.ts:49`).                                                                                                                                                                            | T9                  |
| O8  | Test 10 asserts `State lock is held for state-rebuild by ...`                                                                                                                                                | **Impossible.** `state-lock.ts:446-463` interpolates the **holder's** stored metadata, never the requester's operation label. Rewrite test 10: write the fixture lock with `operation: "deploy"`, then assert (a) bare `rfapps state rebuild` (report) **exits 0** with the lock held — this is what actually catches the `ALWAYS_MUTATING_COMMANDS` collision on the bare name `rebuild`; (b) `rfapps state rebuild --rewrite --yes` **exits 1** with `State lock is held for deploy by other@host` and `invocations` length **0**. **Drop** any assertion on the literal string `"state-rebuild"`. | T10                 |
| O9  | `import.spec.ts`: repoint the `buildConfigSnapshotFromInspect` import **and** move that module into the `vi.mock` bag                                                                                        | The `vi.mock` half is **wrong and would break the suite** — `import.spec.ts:277-292` calls the **real** function. Change **only line 62** into two imports and add **no** `vi.mock` for `runtime-baseline`. Vitest keys mocks on the resolved path, so `lib/runtime-baseline.ts` importing `./docker.js` is already covered by the existing `vi.mock("../lib/docker.js")`.                                                                                                                                                                                                                           | T6                  |
| O10 | "the eight tests in `import.spec.ts`"                                                                                                                                                                        | **Nine**: eight `it()` in `describe("executeImport")` (lines 159, 180, 209, 217, 232, 243, 258, 269) plus one in `describe("buildConfigSnapshotFromInspect")` (line 278). The ninth is _the_ regression proof for the extraction.                                                                                                                                                                                                                                                                                                                                                                    | T6                  |
| O11 | `src/types/index.ts` gets `export * from "./state-rebuild.js";`                                                                                                                                              | That file uses **explicit named re-exports** (see the `./import.js` block at 181-190). Use `export { STATE_REBUILD_SCHEMA_VERSION, STATE_EXPORT_SCHEMA_VERSION } from "./state-rebuild.js";` plus an explicit `export type { ... }` list. **No `export *`.**                                                                                                                                                                                                                                                                                                                                         | T1                  |
| O12 | bash completion step 7: "add `--backup-dir\|--out)` to the `case "$prev"` value block"                                                                                                                       | `--out\|-o` is **already** handled at `completion.ts:196`. A second arm would be unreachable dead code. **Extend line 196** to `--compose\|-f\|--env-file\|-e\|--use-dotenvx\|--use-op\|--from-plan\|--out\|-o\|--backup-dir)`. Additionally add a `--mode)` arm completing `salvage runtime-only` to **bash** and a `-xa "salvage runtime-only"` to **fish** — the design only specified it for zsh, and `completion.spec.ts` parity checks compare option _names_ only, so nothing would catch the inconsistency.                                                                                  | T11                 |
| O13 | `completion.spec.ts` zsh extractor copies `getImportCompletionOptions`'s regex                                                                                                                               | That regex is indentation-coupled to a **top-level** case arm (8-space arm, 10-space `;;`). The `state rebuild` arm is **nested** (16-space arm, 18-space `;;`). Use `/\n {16}rebuild\)\n([\s\S]*?)\n {18};;/`. bash and fish extractors copy over safely.                                                                                                                                                                                                                                                                                                                                           | T11                 |
| O14 | Design step 2 calls `getComposeConfig(...)` after `resolveComposeProjectIdentity`                                                                                                                            | `resolveComposeProjectIdentity` **already** calls `getComposeConfig` internally (`identity.ts:185-190`). Expect **two** `docker compose config` invocations per run — accept this. Also add an error-table row: `resolveComposeProjectIdentity` throws a **plain `Error`** ("Compose path does not exist", "Effective Compose project name could not be resolved safely") with no registered formatter, so it hits the generic fallback → **exit 1**, not `DockerCommandError`.                                                                                                                      | T7                  |
| O15 | `captureBaseline` extraction is a "pure refactor, no behaviour change"                                                                                                                                       | True **only if** `import.ts` passes `cwd: process.cwd()` explicitly (the old code hardcoded it). `state rebuild` passes the compose `projectDir` instead.                                                                                                                                                                                                                                                                                                                                                                                                                                            | T2, T6, T7          |
| O16 | `import.ts` inline entry construction to delete is lines 466-481                                                                                                                                             | It is **465-481** — line 465 is the shared `const timestamp = new Date().toISOString();`, which must move into the extraction's call site. The `generation = 1` hardcode is at **480**.                                                                                                                                                                                                                                                                                                                                                                                                              | T6                  |
| O17 | `GENERATION_ACTIONS` spans `state-storage.ts:68-76`                                                                                                                                                          | It spans **68-75**. Cosmetic; do not hunt for a line 76.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | T3                  |
| O18 | Salvage classifies tracked services via recorded `image_id`; a NULL falls to `stale`                                                                                                                         | Correct, but on a genuine v1/v2 source **every** carried service becomes `stale` (v3 migration deliberately does not backfill `image_id`). The report must distinguish `stale (no recorded image identity — pre-v3 row)` from `stale (recorded image id differs from runtime)` via `StateRebuildServiceResult.reason`, or a legacy-DB rebuild sends the operator to `rfapps reconcile` for the entire stack with no explanation.                                                                                                                                                                     | T7                  |
| O19 | `docs/features/shell-completion.md` list "omits force-unlock, import, and doctor"                                                                                                                            | `doctor` **is** present. Only `force-unlock` and `import` are missing — add those plus `state`. Also lines 141-195 are a **bash code fence** of `# Shows:` comments, not a table: add a `rfapps state rebuild --<TAB>` block to the fence, not a table row.                                                                                                                                                                                                                                                                                                                                          | T-D3                |
| O20 | `README.md` locking section is lines 198-215                                                                                                                                                                 | It starts at **197** (`### State mutation locking`). Cosmetic.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | T-D1                |
| O21 | `cli.ts` release `finally` is 618-639                                                                                                                                                                        | It is **617-634**; `main()` closes at 639. Cosmetic — no code change there anyway.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | T9                  |
| O22 | `docs/README.md` CLI Features index is lines 33-90; command table 299-312                                                                                                                                    | The `**CLI Features:**` block runs **48-72** (insert next to `rfapps-drift-command.md` @54 / `rfapps-reconcile-command.md` @56); the `### rfapps CLI` table is **300-312**.                                                                                                                                                                                                                                                                                                                                                                                                                          | T-D3                |
| O23 | `migrations.spec.ts` is the precedent for "REAL better-sqlite3 on `mkdtemp` files"                                                                                                                           | It predominantly uses `new Database(":memory:")`; only two tests use `mkdtemp` fixture files. Tests 1 and 3 (pure SQL semantics) **should** use `:memory:`; tests 2 and 4 need real files.                                                                                                                                                                                                                                                                                                                                                                                                           | T4                  |
| O24 | spawnSync smoke test precedent is `update.spec.ts` / literal `spawnSync("node", [..., "src/cli.ts", ...])`                                                                                                   | The only precedent is **`src/commands/reconcile.spec.ts:169-183`**. Use its exact form: `spawnSync(process.execPath, ["--import","tsx", fileURLToPath(new URL("../cli.ts", import.meta.url)), "state","rebuild","--help"], { encoding: "utf8" })` with `expect(result.status, result.stderr).toBe(0)`. Also mirror reconcile.spec.ts's "does not load the action while registering or rendering help" assertion.                                                                                                                                                                                     | T9                  |
| O25 | `lib/state-rebuild.ts` exposes exactly six functions                                                                                                                                                         | **Plan addition (not in the design listing):** two more are required and must be implemented — `openReadOnlyStateDatabase(dbPath)` and `readLatestRecordedImageIds(source)`. Rationale below in T4.                                                                                                                                                                                                                                                                                                                                                                                                  | T4                  |
| O26 | `swapStateDatabase` step 1 `chmod(tempPath, 0o600)`                                                                                                                                                          | Redundant (`initializeDatabase` already chmods new files 0600) but **keep it** — it is defensive and harmless. Do not "simplify" it away.                                                                                                                                                                                                                                                                                                                                                                                                                                                            | T4                  |

---

## Batches

| Batch | Task                           | Owns (writes exclusively)                                                                                                                                                                |
| ----- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | T1 `types-state-rebuild`       | `packages/rfapps-cli/src/types/state-rebuild.ts` (new), `packages/rfapps-cli/src/types/index.ts`                                                                                         |
| 1     | T2 `lib-runtime-baseline`      | `packages/rfapps-cli/src/lib/runtime-baseline.ts` (new)                                                                                                                                  |
| 1     | T3 `export-generation-actions` | `packages/rfapps-cli/src/lib/state-storage.ts`                                                                                                                                           |
| 1     | D1 `readme-state-section`      | `packages/rfapps-cli/README.md`                                                                                                                                                          |
| 1     | D2 `recovery-runbook`          | `docs/features/rfapps-state-rebuild.md` (new)                                                                                                                                            |
| 1     | D3 `docs-cross-references`     | `docs/README.md`, `docs/features/deployment-history.md`, `docs/features/shell-completion.md`, `ROADMAP.md`                                                                               |
| 1     | D4 `package-claude-md`         | `packages/rfapps-cli/CLAUDE.md`                                                                                                                                                          |
| 2     | T4 `lib-state-rebuild`         | `packages/rfapps-cli/src/lib/state-rebuild.ts` (new), `packages/rfapps-cli/src/lib/state-rebuild.spec.ts` (new), `packages/rfapps-cli/src/lib/index.ts`                                  |
| 2     | T5 `exit-codes`                | `packages/rfapps-cli/src/lib/exit-codes.ts`                                                                                                                                              |
| 2     | T6 `import-refactor`           | `packages/rfapps-cli/src/actions/import.ts`, `packages/rfapps-cli/src/actions/import.spec.ts`                                                                                            |
| 3     | T7 `action-state-rebuild`      | `packages/rfapps-cli/src/actions/state-rebuild.ts` (new), `packages/rfapps-cli/src/actions/state-rebuild-report.ts` (new), `packages/rfapps-cli/src/actions/state-rebuild.spec.ts` (new) |
| 3     | T8 `action-state-export`       | `packages/rfapps-cli/src/actions/state-export.ts` (new)                                                                                                                                  |
| 4     | T9 `command-and-cli-wiring`    | `packages/rfapps-cli/src/commands/state.ts` (new), `packages/rfapps-cli/src/commands/state.spec.ts` (new), `packages/rfapps-cli/src/cli.ts`                                              |
| 5     | T10 `integration-lock-wiring`  | `packages/rfapps-cli/src/cli.state-rebuild.integration.spec.ts` (new)                                                                                                                    |
| 5     | T11 `shell-completion`         | `packages/rfapps-cli/src/actions/completion.ts`, `packages/rfapps-cli/src/actions/completion.spec.ts`                                                                                    |
| 6     | T12 `verify`                   | _(none — read-only verification, may only fix trivial format/lint issues in files already changed by this PR)_                                                                           |

File ownership is disjoint within every batch. Sequencing rationale: types + the runtime-baseline
extraction + the `GENERATION_ACTIONS` export land first (batch 1), because both `import.ts`'s edit
(T6) and `state-rebuild`'s use (T7) depend on the extraction; SQLite primitives and exit-code
resolvers land next (batch 2); actions consume them (batch 3); the command surface and CLI
registration follow (batch 4) because test 9 spawns the real `cli.ts`; the integration and completion
specs come last (batch 5) because both need `registerStateCommand` to exist.

---

## Risks and how the plan mitigates them

1. **Destroying a state database during a report or a dry run.** Mitigated structurally: the source
   is _only ever_ opened `new Database(path, { readonly: true, fileMustExist: true })`;
   `initializeDatabase()` is called exclusively on the temp path. Test 5 (T7) asserts that the report
   phase calls neither `initializeDatabase`, `backupStateDatabase` nor `swapStateDatabase`, and that
   `--rewrite` under global `--dry-run` degrades to a report with a warning.
2. **Silent state-lock collision on the bare name `rebuild`.** `"rebuild"` is in
   `ALWAYS_MUTATING_COMMANDS` (`cli.ts:62-72`), so without the new `parentName === "state"` branch a
   read-only `rfapps state rebuild` would take the global lock labelled `rebuild`. The branch is
   inserted between `cli.ts:90` and `:91` (after drift, before `ALWAYS_MUTATING_COMMANDS`), and
   test 10 (T10, rewritten per O8) catches the regression by proving a report **exits 0 while a lock
   is held**.
3. **The design's own contradictory signatures** (`swapStateDatabase` 2 vs 3 args, `carryOverState`
   2 vs 3 args). Settled by O3/O4 before any code is written; the signatures are restated verbatim in
   T4's and T7's instructions.
4. **Legacy (v1/v2) source databases throwing `no such column: image_id`.** `carryOverState` builds
   its `SELECT` column list from the intersection of `PRAGMA table_info` and the current schema, and
   gates the `generations` copy on `sqlite_master`. Test 1 (T4) is exactly this case with a v1-shaped
   source.
5. **A legacy rebuild reporting the whole stack as `stale` with no explanation.** O18: the renderer
   distinguishes "no recorded image identity (pre-v3 row)" from "recorded image id differs".
6. **Writing live credentials into the replacement.** `maskSensitiveEnvVars` runs inside
   `buildConfigSnapshotFromInspect` in `lib/runtime-baseline.ts` — one definition shared by `import`
   and `state rebuild`. Test 7 (T7) asserts `***MASKED***` for a token env var.
7. **Corrupt input aborting the salvage transaction.** Every row is validated individually; failures
   increment `deploymentsDiscarded` / `generationsDiscarded` and are skipped. Test 3 (T4) proves a
   `UNIQUE(service, generation)` violation is counted, not thrown.
8. **Breaking operator-recorded rollback targets.** `deployments.id` and `generations.generation` are
   carried verbatim. Test 2 (T4).
9. **Timestamp mis-sorting.** Every ordering path in the codebase is lexicographic string comparison,
   and `schema.sql`'s `DEFAULT (datetime('now'))` produces a space-separated non-ISO form that sorts
   _before_ ISO within the same day. `carryOverState` normalizes it. Test 2 (T4).
10. **Regressing `rfapps import` during the extraction.** The nine existing `import.spec.ts` tests
    (O10) are the regression proof; only line 62 changes and **no** new `vi.mock` is added (O9).
11. **`state rebuild --help` silently losing `Global Options:`.** Commander copies help config at
    subcommand-creation time (O6); the ordering constraint is stated in T9 and pinned by test 9.
12. **Fish completion leaking deploy/rebuild flags into `rfapps state rebuild`.** The 14 lines at
    `completion.ts:930-943` are verified unguarded; T11 appends
    `; and not __fish_seen_subcommand_from state` to each, and `completion.spec.ts` asserts it.
13. **Scope creep into the pre-existing `VALID_ACTIONS` bug.** O5 forbids touching `history.ts` and
    the three `--action` lists; T11's instructions state this as a "must not".

---

## Verification commands

Run from the repo root, in order, in the final batch (T12). All four must pass.

```bash
npm run typecheck
npm run test:rfapps
npm run lint:md
npm run format:check
```

If `format:check` fails, run `npx prettier --write <the specific files this PR changed>` and re-run.
If `lint:md` fails, run `npx markdownlint-cli2 --fix <the specific markdown files this PR changed>`
and re-run. Do **not** run repo-wide `--write` / `--fix` passes that reformat untouched files.

Note for `npm run test:rfapps`: the integration spec spawns the real CLI via `tsx`, which resolves
`@rfmedia/common` through its package `exports` map pointing at `dist/*.js`. If the integration test
fails to resolve `@rfmedia/common`, run `npm run build -w packages/rf-common` first (documented
precondition in `src/testing/cli-harness.ts`).

---

# Execution batches

## Batch 1

### [T1] Add state-rebuild type contracts

**Owns:** packages/rfapps-cli/src/types/state-rebuild.ts, packages/rfapps-cli/src/types/index.ts

**Depends on:** none

**Done when:** `npx tsc --noEmit -p packages/rfapps-cli` reports no error originating in types/state-rebuild.ts or types/index.ts, and both files are prettier-clean.

Create `packages/rfapps-cli/src/types/state-rebuild.ts` containing EXACTLY the type block from the design doc's "## Data structures" section (design.md lines 527-719), verbatim, including every doc comment. It begins with `import type { OutputFormat } from "@rfmedia/common";` and declares:

- `export const STATE_REBUILD_SCHEMA_VERSION = "state-rebuild.v1" as const;`
- `export const STATE_EXPORT_SCHEMA_VERSION = "state-export.v1" as const;`
- `StateRebuildMode`, `StateRebuildPhase`, `StateRebuildDisposition`, `StateDatabaseStatus`, `StateBackupMethod`, `StateRebuildRefusalReason`, `StateRebuildExitCode`, `StateExportExitCode`
- `RawStateRebuildOptions`, `RawStateExportOptions`, `StateCommandGlobalOptions`
- `StateDatabaseProbe`, `StateBackupResult`, `CarryOverCounts`, `StateRebuildServiceResult`, `StateRebuildSummary`, `StateRebuildRefusal`, `StateRebuildResult`, `StateExportResult`

Do not add, rename, or drop any member. Do not widen any type. No `any`.

Then edit `packages/rfapps-cli/src/types/index.ts`.

OVERRIDE O11 (verification correction — the design doc is WRONG here, do not revert): the design says to add `export * from "./state-rebuild.js";`. That file does NOT use star re-exports. Look at the existing `./import.js` block at lines 181-190:

```ts
// Import (adopt external runtime state) types
export { IMPORT_SCHEMA_VERSION } from "./import.js";
export type {
  ImportMode,
  ImportClassification,
  ImportExitCode,
  ImportServiceResult,
  ImportSummary,
  ImportResult,
} from "./import.js";
```

Immediately after that block, add a matching explicit block:

```ts
// State rebuild / export (state database reconstruction) types
export { STATE_REBUILD_SCHEMA_VERSION, STATE_EXPORT_SCHEMA_VERSION } from "./state-rebuild.js";
export type {
  StateRebuildMode,
  StateRebuildPhase,
  StateRebuildDisposition,
  StateDatabaseStatus,
  StateBackupMethod,
  StateRebuildRefusalReason,
  StateRebuildExitCode,
  StateExportExitCode,
  RawStateRebuildOptions,
  RawStateExportOptions,
  StateCommandGlobalOptions,
  StateDatabaseProbe,
  StateBackupResult,
  CarryOverCounts,
  StateRebuildServiceResult,
  StateRebuildSummary,
  StateRebuildRefusal,
  StateRebuildResult,
  StateExportResult,
} from "./state-rebuild.js";
```

DO NOT touch any other part of `types/index.ts`. DO NOT create a spec file for this task — types have no runtime behaviour and the design's critical-test list has no test for them.

When done, run `npx prettier --write packages/rfapps-cli/src/types/state-rebuild.ts packages/rfapps-cli/src/types/index.ts` from the repo root.

### [T2] Extract the shared runtime-baseline observation engine into lib/

**Owns:** packages/rfapps-cli/src/lib/runtime-baseline.ts

**Depends on:** none

**Done when:** `packages/rfapps-cli/src/lib/runtime-baseline.ts` exists, exports `RuntimeBaseline`, `buildConfigSnapshotFromInspect`, `captureRuntimeBaseline`, `toBaselineEntry` with the exact signatures above, imports `maskSensitiveEnvVars` from `./state-storage.js`, and is prettier-clean.

Create `packages/rfapps-cli/src/lib/runtime-baseline.ts`. This is the shared observation engine so that `rfapps import` and `rfapps state rebuild` emit byte-identical state rows from ONE definition (an action must never import another action). You are MOVING code out of `src/actions/import.ts` — but DO NOT edit `import.ts` in this task; task T6 owns that file and will delete the originals.

Source of the code being moved (read it, copy it verbatim except for the changes noted):

- `src/actions/import.ts:91-95` — the `CapturedBaseline` interface
- `src/actions/import.ts:97-115` — `buildConfigSnapshotFromInspect` (including its doc comment)
- `src/actions/import.ts:117-143` — `captureBaseline` (including its doc comment)
- `src/actions/import.ts:465-481` — the inline `StateEntryInput` construction (the shape `toBaselineEntry` must reproduce)

Exports (EXACT signatures):

```ts
export interface RuntimeBaseline {
  readonly identity: DockerContainerIdentity;
  readonly snapshot: ConfigSnapshot;
}

export function buildConfigSnapshotFromInspect(inspect: ContainerInspect): ConfigSnapshot;

export async function captureRuntimeBaseline(
  container: string,
  options: { readonly cwd: string; readonly envTool: EnvToolExecConfig | undefined },
): Promise<RuntimeBaseline | undefined>;

export function toBaselineEntry(service: string, baseline: RuntimeBaseline, timestamp: string): StateEntryInput;
```

Imports this module must use (exact module specifiers — these matter for vitest mock resolution):

- `import { logDebug } from "@rfmedia/common";`
- `import { maskSensitiveEnvVars } from "./state-storage.js";` — NOT from `./index.js`, NOT from `./drift.js`. (`maskSensitiveEnvVars` is defined at `state-storage.ts:128`.)
- `import { parseEnvArray, parsePortBindings } from "./drift.js";`
- `import { inspectContainers, inspectContainerIdentity, type ContainerInspect, type DockerContainerIdentity } from "./docker.js";`
- `import type { ConfigSnapshot, StateEntryInput } from "../types/state.js";`
- `import type { EnvToolExecConfig } from "../types/options.js";`

Behaviour:

1. `buildConfigSnapshotFromInspect` — byte-identical to `import.ts:103-115`. Builds `ports` from `parsePortBindings(inspect.HostConfig.PortBindings).map((port) =>`${port.host ?? ""}:${port.container}/${port.protocol}`)` and returns `{ image: inspect.Config.Image, environment: maskSensitiveEnvVars(parseEnvArray(inspect.Config.Env)), volumes: inspect.HostConfig.Binds ?? [], ports, networks: Object.keys(inspect.NetworkSettings.Networks ?? {}), labels: inspect.Config.Labels ?? {} }`. The masking is a hard requirement — it is the one defect class that would persist live credentials.

2. `captureRuntimeBaseline` — same body as `captureBaseline`, with ONE change (OVERRIDE O15): `cwd` is taken from `options.cwd` instead of the hardcoded `process.cwd()`. So:

   ```ts
   try {
     const identity = await inspectContainerIdentity(container, { cwd: options.cwd, envTool: options.envTool });
     const inspected = await inspectContainers([container], { cwd: options.cwd, envTool: options.envTool });
     const inspect = inspected?.[0];
     if (inspect === undefined) return undefined;
     return { identity, snapshot: buildConfigSnapshotFromInspect(inspect) };
   } catch (error) {
     logDebug(`Failed to inspect container "${container}": ${error instanceof Error ? error.message : String(error)}`);
     return undefined;
   }
   ```

   FAIL-CLOSED is the contract: any throw or missing inspect result returns `undefined` so the caller writes ZERO rows for that service and it stays reconstructible on retry. Do not add a fallback that returns a partial baseline.

3. `toBaselineEntry` — returns exactly the shape `import.ts:466-475` built inline:

   ```ts
   {
     timestamp,
     service,
     action: "import",
     imageTag: baseline.identity.configuredImage,
     imageId: baseline.identity.localImageId,
     imageDigest: baseline.identity.repositoryDigest,
     configSnapshot: JSON.stringify(baseline.snapshot),
     status: "success",
   }
   ```

   The `action` value is the literal `"import"` for BOTH callers. Do NOT invent a `"state-rebuild"` action value — that is explicitly out of scope (design.md §Explicitly out of scope) and would require nine synchronized edits.

Add a module doc comment explaining that this is the single definition of "observe a container and turn it into a state row", shared by `actions/import.ts` and `actions/state-rebuild.ts`.

DO NOT create `runtime-baseline.spec.ts`. The design's critical-test list assigns this module's regression proof to the nine existing tests in `import.spec.ts` (see T6).

DO NOT edit `src/lib/index.ts` (task T4 owns the barrel). DO NOT edit `src/actions/import.ts` (task T6 owns it).

When done, run `npx prettier --write packages/rfapps-cli/src/lib/runtime-baseline.ts` from the repo root.

### [T3] Export GENERATION_ACTIONS from lib/state-storage.ts

**Owns:** packages/rfapps-cli/src/lib/state-storage.ts

**Depends on:** none

**Done when:** `grep -n 'export const GENERATION_ACTIONS' packages/rfapps-cli/src/lib/state-storage.ts` matches, and no other line in the file changed apart from the doc comment.

In `packages/rfapps-cli/src/lib/state-storage.ts`, the constant `GENERATION_ACTIONS` is module-private. It is declared at line 68 and its array literal closes at line 75 (OVERRIDE O17 — the design doc says 68-76; do not hunt for a line 76):

```ts
const GENERATION_ACTIONS: ReadonlySet<DeploymentAction> = new Set<DeploymentAction>([
  "deploy",
  "rebuild",
  "apply",
  "rollback",
  "update",
  "import",
]);
```

Make exactly ONE change: add the `export` keyword so it reads `export const GENERATION_ACTIONS: ReadonlySet<DeploymentAction> = ...`.

Why: `carryOverState` (task T4) re-derives generation rows for pre-v2 sources and must use the SAME vocabulary as `recordDeployment`, not the v2 migration's stale literal `('deploy','rebuild','apply','rollback')` at `migrations.ts:165-166` which omits `update` and `import`. Injecting the exported set is how the two stay in lockstep (OVERRIDE O4: `carryOverState` takes it as a third parameter).

Extend the existing doc comment above the constant with one sentence: that it is exported so state-database reconstruction re-derives generations with the same vocabulary that `recordDeployments` uses.

DO NOT change the set's members. DO NOT change `shouldCreateGeneration`, `recordDeployment`, `recordDeployments`, or anything else in the file. DO NOT edit `src/lib/index.ts` (task T4 owns the barrel). DO NOT edit `src/lib/migrations.ts` — the v2 migration's stale literal is historical and must stay frozen so already-migrated databases are not re-derived differently.

When done, run `npx prettier --write packages/rfapps-cli/src/lib/state-storage.ts` from the repo root.

### [D1] README: add the `### state` section and amend the locking section

**Owns:** packages/rfapps-cli/README.md

**Depends on:** none

**Done when:** `packages/rfapps-cli/README.md` contains a `### state` section between `### import` and `### drift` with the exit-code table and the `cp` restore snippet, the locking section names `state rebuild --rewrite`, and both prettier and markdownlint-cli2 pass on the file.

Edit `packages/rfapps-cli/README.md`. Read `docs/plans/state-rebuild-150/design.md` first — it is the specification for the behaviour you are documenting. Two changes:

**(1) New `### state` section.** Insert it immediately AFTER the existing `### import` section (which runs from line 406 to the end of its four-row exit-code table around line 443) and BEFORE `### drift` (line 445). Use the `### import` section as the structural template: intro paragraph, a fenced `bash` usage block, prose paragraphs, then a markdown exit-code table.

Content it must cover (all sourced from the design doc):

- `rfapps state export` — writes a consistent, private copy of the state database using SQLite's online backup API; read-only; never acquires the state lock (so a precautionary backup is never blocked by a stuck lock); default destination `<state-dir>/backups/state-<timestamp>.db`, overridable with `-o, --out`; global `--dry-run` reports the destination and writes nothing; artifact is mode 600 inside a mode 700 parent; restore is a plain `cp`.
- `rfapps state rebuild` — report-first reconstruction of the WHOLE database file from Docker runtime + compose declarations. A bare invocation opens the existing database READ-ONLY, observes Docker, prints the database that WOULD be built, writes nothing, takes no lock, exits 0. Only `--rewrite` authorizes replacement. Global `--yes` only skips confirmation and never grants write authority. Global `--dry-run` vetoes the rewrite even with `--rewrite`. Machine-format rewrite additionally requires `--yes`.
- **Emphasize**: this is NOT `rfapps rebuild` (which recreates containers). `state rebuild` only touches the rfapps state database; it never mutates Docker and never modifies `compose.yml`.
- A salvage-vs-runtime-only table with columns Mode / Existing rows / Generation numbers / Extra authorization: `salvage` (default) = carried verbatim, preserved, `--rewrite` only; `runtime-only` = discarded, every service restarts at #1, `--rewrite` **plus** `--confirm-project <name>` matching the resolved Compose project.
- The mandatory, non-disableable pre-rewrite backup: there is no `--no-backup`; if the backup cannot be written, nothing is rewritten. Strict order: probe → backup → build replacement → swap. The rebuild never mutates the existing database — it builds a complete replacement beside it and renames it into place, so any failure leaves the original byte-for-byte untouched.
- The exact restore snippet, in a fenced `bash` block:

  ```bash
  rfapps force-unlock                                    # only if a lock is stuck
  cp ~/.config/rfapps/backups/state-2026-07-24T18-15-00-000Z.db ~/.config/rfapps/state.db
  ```

- The boundary against `rfapps import`: `import --adopt` is per-service, additive, appends rows in place, skips any service that already has history, and cannot open a corrupt database. `state rebuild` is a whole-file operation for recovery. To adopt ONE untracked service without touching the rest, use `rfapps import --adopt -s <svc>`. `state rebuild` deliberately has no `-s/--service`, `--services`, `-g/--group` or `--no-sidecars`.
- The `stale` disposition: a service with readable history whose latest generation image id differs from runtime is REPORTED and never rewritten — appending a baseline there would record un-reconciled drift as the newest generation, so `rollback` to latest would restore the drift. Point the operator at `rfapps reconcile` / `rfapps deploy`.
- A four-row exit-code table for `state rebuild`: `0` report completed, or the database was rewritten with nothing discarded; `1` observation, backup, build or swap failed — the database is unchanged in every case; `2` invalid or unsafe usage, cancelled, or the rewrite was refused because the planned replacement would be empty; `3` partial — the database was rewritten but a container could not be inspected or unreadable rows were discarded during salvage.
- A link to the full runbook: `[rfapps State Rebuild](../../docs/features/rfapps-state-rebuild.md)` (that file is created by a sibling task; write the link now).

**(2) Amend `### State mutation locking`.** That section starts at line **197** (OVERRIDE O20 — the design doc says 198; cosmetic). Around lines 207-210 it enumerates the locked operations: "The lock covers pull, build, deploy, stop, rebuild, delete, prune, apply, rollback, drift import, `import --adopt`, and apply modes for plan, update, and reconciliation." That enumeration is the operator's stated basis for judging whether `force-unlock` is safe, so it must stay accurate. Add `state rebuild --rewrite` to the enumeration, and add one sentence stating that `rfapps state export` and report-phase `rfapps state rebuild` are deliberately lock-free (export because the online backup API is safe under concurrent writers and a precautionary backup must not be blocked by a stuck lock; the report because it only reads).

Style: follow the file's existing markdownlint conventions — every heading surrounded by a blank line, fenced code blocks with a language, tables with aligned pipes. Prefer editing over restructuring; do not reflow unrelated sections.

When done, run `npx prettier --write packages/rfapps-cli/README.md` and `npx markdownlint-cli2 packages/rfapps-cli/README.md` from the repo root.

### [D2] New recovery runbook: docs/features/rfapps-state-rebuild.md

**Owns:** docs/features/rfapps-state-rebuild.md

**Depends on:** none

**Done when:** `docs/features/rfapps-state-rebuild.md` exists with all twelve sections, and both prettier and markdownlint-cli2 pass on it.

Create `docs/features/rfapps-state-rebuild.md` — the corrupted-database recovery runbook issue #150 asks for. Read `docs/plans/state-rebuild-150/design.md` FIRST; it is the specification. Use `docs/features/rfapps-reconcile-command.md` and `docs/features/rfapps-drift-command.md` as the structural/tonal template (read at least one of them).

Required sections, in this order:

1. **Title + one-paragraph summary.** `# rfapps State Rebuild`. The rfapps state database is the only record of what rfapps has deployed; it backs `history`, `rollback --to-generation N`, `update` and `reconcile`. `rfapps state rebuild` reconstructs it from Docker runtime and compose declarations; `rfapps state export` takes a consistent backup.

2. **Symptoms — when to use this.** `rfapps history` errors with `SQLITE_NOTADB`; `state.db` is missing; the stored schema version is newer than the CLI understands; services that are demonstrably deployed have vanished from `rfapps history`. Contrast: a single service missing from history but everything else fine → use `rfapps import --adopt -s <svc>`, not this.

3. **State database location.** `~/.config/rfapps/state.db` by default (XDG), with a `~/.rfapps/state.db` legacy fallback when that directory already exists. Overridable by `RFAPPS_STATE_DB_PATH` or `state.dbPath` in the config file. WARN the reader: most other rfapps commands (`deploy`, `rebuild`, `history`, `rollback`, `import`, …) currently read the DEFAULT path and ignore those overrides; `state rebuild` honours the override and prints a loud warning when the two differ, so if you see that warning your other commands are reading a different file.

4. **The recovery sequence.** Numbered, each step a fenced `bash` block plus what to look for:
   1. Diagnose: `rfapps state rebuild` (bare — report-first, read-only, lock-free, exits 0). It prints the resolved path, database status (`missing` / `readable` / `unreadable` with a sanitized reason), schema version, `PRAGMA integrity_check` result, deployment and generation counts, tracked services, and a disposition for every service.
   2. Back up: `rfapps state export` (and `rfapps state export -o <path>`). Note the destination it prints.
   3. Rewrite: `rfapps state rebuild --rewrite` (confirms interactively) or `rfapps state rebuild --rewrite --yes`. A mandatory backup is written first and cannot be disabled.
   4. Verify: `rfapps history --limit 20`, `rfapps history -s <svc> --action import`, `rfapps status --all`.

5. **salvage vs runtime-only decision guide.** A table plus prose. `salvage` (default) carries every readable deployment and generation row into the replacement, preserving deployment ids and generation numbers, then adds baselines only for services with no carried history — correct for "file is gone", "file is damaged" and "file is fine but incomplete" alike, because a missing/unreadable source degenerates salvage into runtime-only automatically. `runtime-only` discards every existing row; every service restarts at generation #1; it therefore requires `--confirm-project <name>` matching the resolved Compose project in addition to `--rewrite`, and `--yes` does not defeat that gate. Recommend salvage unless the operator specifically wants a clean slate.

6. **Backups directory layout and restore.** `<dirname(state.db)>/backups/state-<ISO timestamp with`:`and`.`replaced by`-`>.db`, parent created mode 700, artifacts mode 600. Overridable with `--backup-dir` (rebuild) / `-o, --out` (export). Rebuild refuses to overwrite an existing destination. Restore is a single `cp` an operator can perform with a broken CLI:

   ```bash
   rfapps force-unlock                                    # only if a lock is stuck
   cp ~/.config/rfapps/backups/state-2026-07-24T18-15-00-000Z.db ~/.config/rfapps/state.db
   ```

   Mention that the backup contains full deployment topology and config snapshots — secret-like environment values are masked, but treat the file as sensitive.

7. **Stale lock prerequisite.** Report-phase `state rebuild` and `state export` never take the state lock. Only `state rebuild --rewrite` does, as operation `state-rebuild`. If a stuck lock blocks the rewrite, inspect and clear it with `rfapps force-unlock` — but verify no rfapps CLI or MCP mutation is still active first.

8. **What rebuild can and cannot recover.** Two lists. CAN: image identity (`image_tag` / `image_id` / `image_digest`) and config snapshots for every observed, inspectable container — including containers that are created-but-exited, because discovery uses `docker compose ps --all` (unlike `rfapps import`, which uses `ps --status running`). CANNOT: failed deployments (`status: "failed"` — Docker keeps no record); `plan_id` linkage to saved plans; original deployment timestamps (a container's `StartedAt` is a restart time, not a deploy time — recording it would corrupt `history --since` and generation-at-time lookups, so the rebuild timestamp is used); pre-rebuild generation numbers under `runtime-only`; history for services with no container and no readable source rows (reported in `summary.droppedServices`); unmasked environment values (masking is by design).

9. **Dispositions reference.** A table of the six values with one line each: `reconstructed`, `carried`, `stale`, `orphaned`, `absent`, `uninspectable` — copy the semantics from the design doc's `StateRebuildDisposition` doc comment. Call out that `stale` is reported and NEVER rewritten, and why (appending a baseline for a drifted service would record the drift as the current generation, so `rollback` to latest would restore the drift) — the fix is `rfapps reconcile` / `rfapps deploy`. Also note that on a pre-v3 database, services can be classified `stale` simply because no image id was ever recorded; the report distinguishes that case in its reason text.

10. **The `state-rebuild.v1` JSON contract.** `rfapps state rebuild --json` emits the whole envelope to stdout. List the top-level fields (`schemaVersion`, `operation`, `phase`, `mode`, `project`, `composePath`, `database`, `backup?`, `carryOver?`, `services`, `summary`, `refusal?`, `success`, `exitCode`) and state the machine-checkable safety invariant: after a clean salvage, `summary.discardedDeployments === 0 && summary.discardedGenerations === 0`; `database.path` and `database.isDefaultPath` are always present so automation can prove which file was touched. Machine-format rewrite additionally requires global `--yes`. Note that `refusal.reason === "empty-plan"` (exit 2) is emitted as a RESULT, not an exception, so CI can read it.

11. **Boundary table** vs `rfapps import --adopt` and `rfapps drift import` — reproduce the design doc's boundary table (design.md lines 40-52) and the "Which do I use?" bullets (lines 56-59).

12. **Exit codes** table for `state rebuild` (0/1/2/3) and for `state export` (0/1/2), matching the design doc's §Exit codes.

Style: markdownlint-clean. Every heading surrounded by blank lines. Every fenced block has a language. No trailing whitespace. Tables with a header separator row.

When done, run `npx prettier --write docs/features/rfapps-state-rebuild.md` and `npx markdownlint-cli2 docs/features/rfapps-state-rebuild.md` from the repo root.

### [D3] Docs cross-references: index, deployment-history path fix, shell-completion list, ROADMAP

**Owns:** docs/README.md, docs/features/deployment-history.md, docs/features/shell-completion.md, ROADMAP.md

**Depends on:** none

**Done when:** `grep -rn 'local/share/rfapps' docs/` returns nothing; docs/README.md links features/rfapps-state-rebuild.md and has a `rfapps state rebuild` table row; shell-completion.md's command list contains force-unlock, import and state plus a `rfapps state rebuild --<TAB>` block; ROADMAP.md line 74 is struck through and the medium-priority heading reads (11) with no #150 row; prettier and markdownlint-cli2 pass on all four files.

Four small, independent documentation edits. Read `docs/plans/state-rebuild-150/design.md` §Docs impact for context.

---

**(1) `docs/README.md`** (OVERRIDE O22 — the design doc's line numbers are approximate; use these):

- The `**CLI Features:**` block starts at line 48 and runs to about line 72. `rfapps-drift-command.md` is linked at line 54 and `rfapps-reconcile-command.md` at line 56. Insert a new bullet right after the reconcile entry, matching the surrounding two-line wrapped style:

  ```markdown
  - [rfapps State Rebuild](features/rfapps-state-rebuild.md) - Report-first reconstruction of the
    state database from Docker runtime, with mandatory backup and atomic replacement
  ```

- The `### rfapps CLI` heading is at line 296 and its command table spans lines 300-312 (11 rows, columns `Command | Description | Confirmation`). Append one row after the `rfapps reconcile` row:

  ```markdown
  | `rfapps state rebuild` | Reconstruct the state DB from Docker runtime | Rewrite only |
  ```

  Keep the pipe alignment consistent with the rest of the table (prettier will normalize it).

---

**(2) `docs/features/deployment-history.md` — the wrong-path fix (IN SCOPE, verified by the lead).**

`src/lib/db.ts:38-46` resolves `~/.config/rfapps/state.db` (XDG) with a `~/.rfapps` legacy fallback. It NEVER resolves `~/.local/share`. Two occurrences are wrong:

- Line 392 (inside the `## State Database Location` section whose heading is at line 387): the fenced block containing `~/.local/share/rfapps/state.db`.
- Line 431: `2. Verify the database path exists: \`ls ~/.local/share/rfapps/state.db\``.

Fix both to `~/.config/rfapps/state.db`. The sentence following line 392 currently says the location "can be customized via the `XDG_DATA_HOME` environment variable" — that is also wrong; replace it with prose stating the resolution order actually implemented: `~/.config/rfapps/state.db` preferred (XDG), `~/.rfapps/state.db` used only when that legacy directory already exists, and the path is overridable via the `RFAPPS_STATE_DB_PATH` environment variable or `state.dbPath` in the rfapps config file.

Then add a cross-reference to the new runbook in TWO places: at the end of the `## State Database Location` section (line 387's section) and at the end of the `### Database Not Found` section (heading at line 434). Use the form:

```markdown
If the database is corrupt, missing, or has lost services, see
[rfapps State Rebuild](rfapps-state-rebuild.md).
```

Do not restructure the rest of the file.

---

**(3) `docs/features/shell-completion.md`** (OVERRIDE O19 — the design doc's claim about what is missing is partly wrong):

- Lines 119-121 hold a hand-maintained command list inside a `bash` code fence under `### Commands`. It currently reads `status health pull build deploy stop rebuild delete prune plan update reconcile apply history rollback drift lint audit doctor completion init validate mcp`. `doctor` IS already present — the design doc is wrong about that. What is actually missing is `force-unlock` and `import`. Add `force-unlock`, `import`, AND `state` so the list matches the real 26-command surface, keeping the two-line `# Includes:` / `#` continuation-comment wrapping.
- Lines 141-195 are a `bash` code fence of `rfapps <cmd> --<TAB>` invocations each followed by `# Shows: ...` comment lines — it is NOT a table (the design doc calls it a per-command option table; it is not). Add a new block inside that fence, in the same style, after the existing blocks:

  ```bash
  # State rebuild command options
  rfapps state rebuild --<TAB>
  # Shows: --mode --rewrite --confirm-project --running-only --backup-dir
  #        --show-unchanged --compose --env-file --profile
  ```

---

**(4) `ROADMAP.md`:**

- Line 74 is the Sprint 3 row: `| 4     | [#150](https://github.com/yandy-r/rfmedia-apps/issues/150) Rebuild state from runtime | Recover when state DB and Docker diverge |`. Strike it through following the EXACT convention already used on line 71 (#65) and line 73 (#149): wrap the linked title in `~~…~~` and append `— shipped 2026-07-24`. Look at line 73 and copy its punctuation and spacing precisely.
- Line 97 is the `#150` row in the `### Medium priority — state, security & deploy (12)` table (heading at line 88). DELETE that row and change the heading's count from `(12)` to `(11)`.

Do not touch any other roadmap row.

---

When done, run from the repo root:
`npx prettier --write docs/README.md docs/features/deployment-history.md docs/features/shell-completion.md ROADMAP.md`
and
`npx markdownlint-cli2 docs/README.md docs/features/deployment-history.md docs/features/shell-completion.md ROADMAP.md`

### [D4] Update packages/rfapps-cli/CLAUDE.md structure tree and record the state-DB invariant

**Owns:** packages/rfapps-cli/CLAUDE.md

**Depends on:** none

**Done when:** All seven new source files appear in CLAUDE.md's structure tree with correct box-drawing characters, the state-database invariant is recorded, and prettier + markdownlint-cli2 pass on the file.

Edit `packages/rfapps-cli/CLAUDE.md`. PR #267 set the precedent of updating this file when the package's structure changes.

**(1) Structure tree.** The tree is a fenced block spanning roughly lines 28-90. Add the seven new files in the correct alphabetical position within their existing sub-lists, matching the existing two-space-aligned `# comment` column style:

- Under `│   ├── commands/           # Dedicated command definitions` (line 33; currently lists only `init.ts` and `update.ts` — note the tree is already incomplete, that is fine, just add ours):
  - `│   │   └── state.ts        # State database inspect/export/rebuild command group`
    (adjust the existing last entry's box-drawing character from `└──` to `├──` if `state.ts` sorts after it — `state.ts` sorts after `update.ts`? No: alphabetically `init` < `state` < `update`, so insert `state.ts` between them with `├──` and leave `update.ts` as `└──`.)
- Under `│   ├── actions/` (line 36), in alphabetical position:
  - `│   │   ├── state-export.ts # Export a consistent copy of the state database`
  - `│   │   ├── state-rebuild.ts # Reconstruct the state database from Docker runtime`
  - `│   │   ├── state-rebuild-report.ts # Text renderer for the rebuild report`
    (these sort between `status.ts` and `stop.ts`? Alphabetically: `state-*` < `status` < `stop`. Insert them before `status.ts`.)
- Under `│   ├── lib/` (line 54), in alphabetical position:
  - `│   │   ├── runtime-baseline.ts # Shared container→state-row observation engine`
  - `│   │   ├── state-rebuild.ts # SQLite probe/backup/carry-over/swap primitives`
    (`runtime-baseline.ts` sorts between `plan-storage.ts` and `schema.sql`; `state-rebuild.ts` sorts between `service-status.ts`/`services.ts` and `state-queries.ts` — precisely: `state-queries` < `state-rebuild` < `state-storage`, so insert between `state-queries.ts` and `state-storage.ts`.)
- Under `│   └── types/` (line 78), in alphabetical position:
  - `│       ├── state-rebuild.ts # StateRebuildResult, StateDatabaseProbe, CarryOverCounts`
    (`state.ts` < `state-rebuild.ts`? ASCII `.` (0x2E) < `-` (0x2D)? No: `-` is 0x2D and `.` is 0x2E, so `state-rebuild.ts` sorts BEFORE `state.ts`. Insert it immediately before the `state.ts` line.)

Keep the box-drawing characters consistent — whichever entry is last in each sub-list keeps `└──`, all others use `├──`.

**(2) Record the invariant.** Add a short subsection (2-4 sentences) in the state/database area of the document — a natural home is near the existing `// src/lib/db.ts` / `// src/lib/state-storage.ts` code-comment blocks around lines 232-260, or as a new `### State database invariant` heading right after that group. It must state:

> The state database is **derived and re-derivable**. Never open a suspect database through `initializeDatabase()` — it opens read-write, `exec()`s `schema.sql`, and runs migrations, so a corrupt file throws `SQLITE_NOTADB` before any recovery code can run. Diagnose and back up through a read-only handle (`new Database(path, { readonly: true, fileMustExist: true })`), and repair by constructing a complete replacement at a sibling temp path via `initializeDatabase(tempPath)` and `rename()`-ing it into place, so every failure before the swap is indistinguishable from "nothing happened". See `src/lib/state-rebuild.ts` and `docs/features/rfapps-state-rebuild.md`.

Rewrite that in the file's own voice/formatting; do not paste it as a blockquote if the surrounding style is prose.

Do not restructure or reflow anything else in the file.

When done, run `npx prettier --write packages/rfapps-cli/CLAUDE.md` and `npx markdownlint-cli2 packages/rfapps-cli/CLAUDE.md` from the repo root.

## Batch 2

### [T4] lib/state-rebuild.ts SQLite + filesystem primitives, spec (tests 1-4), and lib barrel

**Owns:** packages/rfapps-cli/src/lib/state-rebuild.ts, packages/rfapps-cli/src/lib/state-rebuild.spec.ts, packages/rfapps-cli/src/lib/index.ts

**Depends on:** T1, T2, T3

**Done when:** `npx vitest run src/lib/state-rebuild.spec.ts` (from packages/rfapps-cli) passes with exactly 4 tests; `npx tsc --noEmit -p packages/rfapps-cli` is clean for these files; lib/index.ts re-exports all eight state-rebuild primitives, the three runtime-baseline symbols, and GENERATION_ACTIONS.

Create `packages/rfapps-cli/src/lib/state-rebuild.ts` — every SQLite-level and filesystem-level primitive the rebuild/export actions need. No orchestration, no Commander, no Docker. Read design.md §Rebuild semantics (lines 208-410) for full context. Target ~330 lines; if it exceeds ~500 you may split file primitives into a sibling module, but prefer keeping it whole.

### Exported API (EXACT signatures — these are authoritative and settle two contradictions in the design doc)

```ts
export async function probeStateDatabase(dbPath: string): Promise<StateDatabaseProbe>;
export function openReadOnlyStateDatabase(dbPath: string): DbConnection | undefined;
export function readLatestRecordedImageIds(source: DbConnection): Map<string, string | undefined>;
export async function backupStateDatabase(dbPath: string, destinationPath: string): Promise<StateBackupResult>;
export function buildReplacementDatabasePath(targetPath: string): string;
export function defaultBackupPath(dbPath: string, backupDir: string | undefined, now: Date): string;
export function carryOverState(
  source: DbConnection,
  target: DbConnection,
  generationActions: ReadonlySet<DeploymentAction>,
): CarryOverCounts;
export async function swapStateDatabase(tempPath: string, targetPath: string): Promise<void>;
```

**OVERRIDE O3 (design doc contradicts itself — this plan wins):** `swapStateDatabase` takes TWO parameters. design.md:400 shows a third `backupPath`; it is never used by the swap algorithm (the backup already exists on disk). Do NOT add it.

**OVERRIDE O4 (design doc contradicts itself — this plan wins):** `carryOverState` takes THREE parameters. design.md:325 shows the 2-arg form; the 3-arg form in the listing (design.md:758-762) is correct. The caller injects the `GENERATION_ACTIONS` set exported by T3.

**OVERRIDE O25 (plan addition — NOT in the design's listing, but required):** `openReadOnlyStateDatabase` and `readLatestRecordedImageIds` are new. Rationale: the action needs a read-only source handle for carry-over that is separate from the probe's (the probe opens and closes its own), and it must compute the `stale` disposition from the SOURCE before any target exists (the report phase has no target). Implement both.

### Imports

- `import Database from "better-sqlite3";` — better-sqlite3's typings use `export = Database`; there is NO named `Database` export. Mirror `src/lib/db.ts:19` and `src/testing/cli-harness.ts:18` exactly.
- `import type { DbConnection } from "./db.js";` and `import { getDefaultDatabasePath } from "./db.js";`
- `import { logDebug } from "@rfmedia/common";`
- `import type { DeploymentAction } from "../types/state.js";`
- `import type { StateDatabaseProbe, StateBackupResult, CarryOverCounts } from "../types/state-rebuild.js";`
- node builtins: `node:fs/promises` (`mkdir`, `chmod`, `copyFile`, `rename`, `rm`, `stat`, `access`), `node:fs` (`constants`), `node:path` (`basename`, `dirname`, `join`).

### Behaviour

**`openReadOnlyStateDatabase(dbPath)`** — `try { return new Database(dbPath, { readonly: true, fileMustExist: true }); } catch { return undefined; }`. Precedent: `src/lib/doctor/checkers.ts:326`, `src/testing/cli-harness.ts:276`. NEVER open the source read-write. `initializeDatabase()` is called EXCLUSIVELY on the temp path elsewhere.

**`probeStateDatabase(dbPath)` — NEVER THROWS.** Returns a `StateDatabaseProbe`.

- `path = dbPath`; `isDefaultPath = dbPath === getDefaultDatabasePath()`.
- If the file does not exist (`access`) → `{ path, status: "missing", isDefaultPath }`.
- Else open read-only via `openReadOnlyStateDatabase`. If that returns `undefined` → `status: "unreadable"` with a sanitized `reason` (the caught error's `message`, truncated to ~200 chars, with no absolute paths beyond `dbPath` itself).
- Run `PRAGMA integrity_check` inside its own try/catch. Non-`"ok"` result or a throw → `status: "unreadable"` with `integrity: "failed"` and a reason.
- Read `SELECT value FROM metadata WHERE key = 'schema_version'` in its own try/catch → `schemaVersion` (parsed as an integer; leave undefined if absent/unparseable). If `schemaVersion > 3` (the value of `CURRENT_SCHEMA_VERSION` in `src/lib/migrations.ts:32`) → `status: "unreadable"` with reason `"Stored schema version <n> is newer than this CLI supports (3)"`. This is deliberate: `runMigrations`'s plain-`Error` guard at `migrations.ts:104-112` has no registered formatter, and the probe must report the condition instead of letting an unformatted error escape.
- **Every count query is INDIVIDUALLY try/catch'd and gated on `sqlite_master`.** A real v1 database has NO `generations` table at all. Use a helper that checks `SELECT name FROM sqlite_master WHERE type='table' AND name = ?` before querying. Collect: `deployments` (COUNT), `generations` (COUNT, undefined if the table is absent), `trackedServices` (`SELECT DISTINCT service FROM deployments ORDER BY service`), `oldestTimestamp` (`SELECT MIN(timestamp) FROM deployments`), `newestTimestamp` (`SELECT MAX(timestamp) FROM deployments`).
- ALWAYS `db.close()` in a `finally`.
- If the file opened and integrity passed → `status: "readable"`.

**`readLatestRecordedImageIds(source)` — NEVER THROWS.** Returns `Map<service, image_id | undefined>`. Gate on `sqlite_master`. Preferred query (when `generations` exists): for each service, the `image_id` of the highest `generation` — e.g. `SELECT service, image_id FROM generations WHERE (service, generation) IN (SELECT service, MAX(generation) FROM generations GROUP BY service)` or an equivalent per-service query. Fallback when `generations` is absent: `SELECT service, image_id FROM deployments WHERE status = 'success' GROUP BY service HAVING id = MAX(id)` or an equivalent per-service latest-successful lookup. On any throw, return whatever was collected (possibly empty). A service present with a NULL image id MUST appear in the map with value `undefined` — the caller distinguishes "no recorded identity" from "not tracked" (see O18).

**`buildReplacementDatabasePath(targetPath)`** — a SIBLING path in the SAME directory (same filesystem ⇒ `rename` is atomic): `join(dirname(targetPath),`.${basename(targetPath)}.rebuild-${process.pid}.tmp`)`. Pure function, no I/O.

**`defaultBackupPath(dbPath, backupDir, now)`** — pure. `const dir = backupDir ?? join(dirname(dbPath), "backups");` `const stamp = now.toISOString().replace(/[:.]/gu, "-");` return `join(dir,`state-${stamp}.db`)`. (e.g. `state-2026-07-24T18-15-00-000Z.db`.)

**`backupStateDatabase(dbPath, destinationPath)`**

1. `await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 })`.
2. **Refuse to overwrite**: if `destinationPath` already exists, throw `new Error("Backup destination already exists: <path>")`.
3. Primary, `method: "sqlite-backup"` — SQLite's online backup API, consistent under a concurrent writer and journal-safe:

   ```ts
   const source = new Database(dbPath, { readonly: true, fileMustExist: true });
   try {
     await source.backup(destinationPath);
   } finally {
     source.close();
   }
   ```

   Then `await chmod(destinationPath, 0o600)`, `stat` for `bytes`, return `{ path: destinationPath, method: "sqlite-backup", bytes, sidecars: [] }`.
   Do NOT substitute `copyFile` here — a plain copy of a live SQLite database is not consistent, which is exactly why `drift import --backup`'s `copyFile` precedent (`actions/drift.ts:340`) is deliberately not reused.

4. Fallback, `method: "raw-copy"` — on ANY throw from step 3 (e.g. `SQLITE_NOTADB` on a corrupt file): first `await rm(destinationPath, { force: true })` to clear a partial artifact, then `await copyFile(dbPath, destinationPath)` and `chmod 0o600`. For each of `${dbPath}-wal` and `${dbPath}-shm` that exists, `copyFile` it to `${destinationPath}-wal` / `${destinationPath}-shm`, `chmod 0o600`, and push its destination path into `sidecars`. Return `{ path, method: "raw-copy", bytes, sidecars }`. The disaster path must not depend on the happy path working — forensic bytes are preserved even when SQLite cannot parse the file. `logDebug` the reason for the fallback.
5. If the fallback ALSO throws, let it propagate — the caller maps it to exit 1 and rewrites nothing.

**`carryOverState(source, target, generationActions)` — runs inside a SINGLE `target.transaction(...)`.** Returns `CarryOverCounts` (`deploymentsCarried`, `deploymentsDiscarded`, `generationsCarried`, `generationsDiscarded`, `generationsDerived`).

1. Read the source's table set from `sqlite_master`. If `deployments` is absent, return all-zero counts.
2. `PRAGMA table_info(deployments)` → build the `SELECT` column list from the **intersection** of the current schema's columns (`id, timestamp, service, action, image_tag, image_id, image_digest, config_snapshot, status, plan_id, error_message`) and what the source actually has. A v1 source has NO `image_id` / `image_digest` — naming them unconditionally throws `no such column: image_id` on exactly the legacy databases the migration system exists for. Missing columns are inserted as `NULL`.
3. `SELECT <cols> FROM deployments ORDER BY id ASC`. Validate each row: `id` a positive integer; `service`, `action`, `status`, `timestamp` non-empty strings. A failure increments `deploymentsDiscarded` and the row is SKIPPED — **never abort the transaction**; corrupt input is the input this command exists for.
4. Normalize timestamps: a value matching `/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u` (schema.sql's `DEFAULT (datetime('now'))` form) is rewritten to ISO 8601 (`new Date(`${value.replace(" ", "T")}Z`).toISOString()` — the SQL default is UTC). Every ordering path in the codebase is lexicographic (`ORDER BY timestamp DESC`, `timestamp >= ?`, `findGenerationAtTime`), and `' '` (0x20) sorts before `'T'`, so mixed formats silently mis-sort within a day.
5. Insert into the target **preserving the explicit `id`**. `deployments.id` is user-facing: printed by `rfapps history`, resolved by `findDeploymentById`, and a rollback target via `RollbackOptions.toDeployment`. Letting `AUTOINCREMENT` renumber would break every id an operator wrote down. Explicit ids also advance `sqlite_sequence` correctly. Track carried ids in a `Set<number>`.
6. If the source has a `generations` table: `PRAGMA table_info(generations)` → intersection again (a v2 table has no `image_id` / `image_digest`). Copy rows `ORDER BY id ASC`, preserving `generation` VERBATIM (`rollback --to-generation N` and operator runbooks reference those numbers). Keep `deployment_id` when it is in the carried id set; set it to `NULL` otherwise, keeping the FK valid under `pragma foreign_keys = ON` (which `initializeDatabase` enables on the target). Discard-and-count rows with a non-integer `generation`, an empty `service`, or a duplicate `(service, generation)` — pre-detect duplicates with a `Set<string>` keyed `${service}\0${generation}` so `UNIQUE(service, generation)` never actually fires. Normalize `generations.timestamp` the same way as step 4 (`generations.timestamp` is NOT NULL with NO default, so it must always be supplied).
7. **Only if** `deploymentsCarried > 0 && generationsCarried === 0` (the source predates v2, or its generations table was lost), re-derive generations in the target with the shape of the v2 migration (`src/lib/migrations.ts:151-167`): `ROW_NUMBER() OVER (PARTITION BY service ORDER BY timestamp ASC, id ASC)` — but filtered by the INJECTED `generationActions` set, NOT v2's stale literal `('deploy','rebuild','apply','rollback')` which omits `update` and `import`. Build the `action IN (...)` list by binding the injected set's members. Set `generationsDerived` to the number of rows inserted.
8. `metadata` is **NOT** carried. The replacement keeps the fresh `schema_version` stamped by `runMigrations()` — carrying a stale or future version is exactly the corruption being repaired.

**`swapStateDatabase(tempPath, targetPath)`**

1. `await chmod(tempPath, 0o600)` — redundant (OVERRIDE O26: `initializeDatabase` already chmods new files 0600) but defensive; keep it.
2. `await rename(tempPath, targetPath)` — same directory ⇒ same filesystem ⇒ atomic.
3. `await rm(`${targetPath}-wal`, { force: true })` and the same for `-shm`. Those sidecars belong to the file that was just replaced; a stale WAL beside a fresh database can be replayed onto it and corrupt it. Nothing in the repo enables WAL today — this is two defensive lines closing a real vector if a future version or an external tool ever opens the DB in WAL mode.

On ANY failure inside `swapStateDatabase`, `await rm(tempPath, { force: true })` and rethrow. The target must be byte-identical to before.

### Barrel: `packages/rfapps-cli/src/lib/index.ts`

Add two export blocks in the style of the surrounding blocks (see the `// Database utilities` block at lines 203-212 and the `// State storage utilities` block at 217-225). Place them near those:

```ts
// State database reconstruction primitives
export {
  probeStateDatabase,
  openReadOnlyStateDatabase,
  readLatestRecordedImageIds,
  backupStateDatabase,
  buildReplacementDatabasePath,
  defaultBackupPath,
  carryOverState,
  swapStateDatabase,
} from "./state-rebuild.js";

// Shared runtime observation engine (container -> state row)
export { buildConfigSnapshotFromInspect, captureRuntimeBaseline, toBaselineEntry } from "./runtime-baseline.js";
export type { RuntimeBaseline } from "./runtime-baseline.js";
```

Also add `GENERATION_ACTIONS` to the EXISTING `// State storage utilities` export block (T3 exported it from `state-storage.ts`).

Do NOT export anything from `./state-lock.js` — it is deliberately unexported from the barrel.

### Spec: `packages/rfapps-cli/src/lib/state-rebuild.spec.ts` — tests 1-4 ONLY

Use REAL `better-sqlite3` (mocking SQLite here would prove nothing about SQL semantics). Follow `src/lib/migrations.spec.ts`: it mocks only `@rfmedia/common` → `{ logDebug: vi.fn() }` (migrations.spec.ts:16-18) and reads the live schema with `readFileSync(new URL("./schema.sql", import.meta.url))` (line 29).

**OVERRIDE O23:** the design says "REAL better-sqlite3 on `mkdtemp` files". migrations.spec.ts actually uses `new Database(":memory:")` for most tests and `mkdtemp` files only where a real path is needed. Use `:memory:` for tests 1 and 3 (pure SQL semantics) and `mkdtemp(join(tmpdir(), "rfapps-state-rebuild-"))` files for tests 2 and 4. Clean up with `rm(dir, { recursive: true, force: true })` in `afterEach`.

For targets, build them with `await initializeDatabase(tempPath)` (mirrors production) or, for `:memory:` targets, `new Database(":memory:")` + `db.pragma("foreign_keys = ON")` + `db.exec(schema)`. For v1/v2-shaped SOURCES, hand-write the legacy DDL — copy the `V1_SCHEMA` fixture at `migrations.spec.ts:34-52` (metadata + deployments only, deployments WITHOUT `image_id`/`image_digest`, no `generations` table) and, for v2, the `generations` DDL at `migrations.ts:128-139` (also without `image_id`/`image_digest`).

1. **`carryOverState` on a v1-shaped source** (no `generations` table, no `image_id`/`image_digest` columns) carries the deployments, re-derives generations using the REAL `GENERATION_ACTIONS` imported from `./state-storage.js`, and DOES NOT THROW. Assert `deploymentsCarried` equals the source row count, `generationsCarried === 0`, `generationsDerived > 0`, and that a row whose `action` is `"update"` or `"import"` DID get a derived generation (this is the exact difference from the v2 migration's stale literal).
2. **`carryOverState` preserves ids and generation numbers** (mkdtemp files): seed a v3-shaped source with non-contiguous `deployments.id` values (e.g. 5, 9, 40), generations referencing them with non-contiguous `generation` values (e.g. 3, 7), and ONE deployment row whose `timestamp` is in the `datetime('now')` space-separated form. Assert the target's `deployments.id` set is identical, `generations.generation` values are identical, every carried `generations.deployment_id` is either NULL or present in the carried deployment id set (FK-valid under `foreign_keys = ON`), and the space-separated timestamp came out matching `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u`.
3. **`carryOverState` discards and COUNTS a `UNIQUE(service, generation)` violation** instead of aborting: seed a source `generations` table containing two rows with the same `(service, generation)` (create the source table WITHOUT the unique constraint so the duplicate can exist). Assert exactly one is carried, `generationsDiscarded === 1`, and every other row still made it into the target — the transaction must not have rolled back.
4. **`backupStateDatabase` fallback + `swapStateDatabase`** (mkdtemp files): write a file that is NOT a valid SQLite database (e.g. `writeFile(path, "not a database")`) plus `${path}-wal` and `${path}-shm` siblings. Assert `backupStateDatabase` returns `method: "raw-copy"`, `sidecars` contains both sidecar destinations, the destination file's mode is `0o600` (`(statSync(dest).mode & 0o777) === 0o600`), and the destination bytes equal the source bytes. Separately: create a temp file and a target file plus stale `${target}-wal`/`-shm`, call `swapStateDatabase(temp, target)`, and assert the target now has the temp's contents, the temp path no longer exists, and both stale sidecars are gone.

Do NOT write any other test in this file.

When done, run `npx prettier --write packages/rfapps-cli/src/lib/state-rebuild.ts packages/rfapps-cli/src/lib/state-rebuild.spec.ts packages/rfapps-cli/src/lib/index.ts` from the repo root.

### [T5] Add resolveStateRebuildExitCode / resolveStateExportExitCode

**Owns:** packages/rfapps-cli/src/lib/exit-codes.ts

**Depends on:** T1

**Done when:** `resolveStateRebuildExitCode` and `resolveStateExportExitCode` are exported from src/lib/exit-codes.ts with the exact bodies above, and `npx tsc --noEmit -p packages/rfapps-cli` reports no error in that file.

Edit `packages/rfapps-cli/src/lib/exit-codes.ts`. Add two resolvers beside the existing `resolveReconcileExitCode` (line 38), `resolveDeployExitCode` (line 45) and `resolveLintExitCode` (line 69). Follow their shape exactly: a pure function taking the result (plus an optional modifier) and returning `ExitCodeValue`, with a one-line JSDoc.

Add to the imports at the top of the file, matching the existing `import type { ... } from "../types/....js";` style:

```ts
import type { StateRebuildResult, StateExportResult } from "../types/state-rebuild.js";
```

Add:

```ts
/** Derive the process exit category for a completed state-rebuild result. */
export function resolveStateRebuildExitCode(result: Omit<StateRebuildResult, "exitCode" | "success">): ExitCodeValue {
  if (result.refusal !== undefined) {
    return ExitCode.UsageError;
  }
  if (result.phase === "report") {
    return ExitCode.Success;
  }
  if (
    result.summary.uninspectable > 0 ||
    result.summary.discardedDeployments > 0 ||
    result.summary.discardedGenerations > 0
  ) {
    return ExitCode.PartialSuccess;
  }
  return ExitCode.Success;
}

/** Derive the process exit category for a completed state-export result. */
export function resolveStateExportExitCode(result: Omit<StateExportResult, "exitCode" | "success">): ExitCodeValue {
  if (result.dryRun || result.backup !== undefined) {
    return ExitCode.Success;
  }
  return ExitCode.OperationalError;
}
```

Semantics being encoded (design.md §Exit codes, lines 192-206):

- A report phase ALWAYS exits 0, even when the pre-existing database was `unreadable` — that is the expected input to a recovery command, not a partial result. Do NOT add an `unreadable`-based branch.
- Exit 3 (partial) means the database WAS rewritten but at least one observed container was uninspectable OR rows were discarded during salvage.
- Exit 2 covers the structured `empty-plan` refusal. Argument-shaped refusals (`--confirm-project` missing/mismatched, machine format without `--yes`, `state.enabled === false`) throw `InvalidArgumentError` instead and never reach this function; its registered formatter already maps to `ExitCode.UsageError`.
- Exit 1 (observation/backup/build/swap failure) and the declined-confirmation exit 2 are set directly with `setExitCode` in the action, because no result envelope is produced on those paths. Do NOT try to model them here.

Do NOT add a spec file — the design's critical-test list has no test for exit-codes; the resolvers are exercised through `actions/state-rebuild.spec.ts` (tests 5-8). Do NOT modify any existing resolver, `ExitCode`, or `setExitCode`.

When done, run `npx prettier --write packages/rfapps-cli/src/lib/exit-codes.ts` from the repo root.

### [T6] Refactor actions/import.ts onto lib/runtime-baseline.ts (pure refactor)

**Owns:** packages/rfapps-cli/src/actions/import.ts, packages/rfapps-cli/src/actions/import.spec.ts

**Depends on:** T2

**Done when:** `npx vitest run src/actions/import.spec.ts` (from packages/rfapps-cli) passes all 9 tests with no spec assertion changed; `grep -n 'captureBaseline\|buildConfigSnapshotFromInspect\|parseEnvArray\|maskSensitiveEnvVars' packages/rfapps-cli/src/actions/import.ts` returns nothing; `npx tsc --noEmit -p packages/rfapps-cli` reports no unused-import or type error in import.ts.

Pure refactor with NO behaviour change and NO compatibility re-export. `packages/rfapps-cli/src/lib/runtime-baseline.ts` already exists (created by task T2) and exports `RuntimeBaseline`, `buildConfigSnapshotFromInspect`, `captureRuntimeBaseline`, `toBaselineEntry` — read it first.

### `packages/rfapps-cli/src/actions/import.ts`

DELETE these blocks (line numbers are for the current file; verify by content):

- lines 91-95: the `interface CapturedBaseline { identity: DockerContainerIdentity; snapshot: ConfigSnapshot; }`
- lines 97-115: the doc comment + `export function buildConfigSnapshotFromInspect(...)`
- lines 117-143: the doc comment + `async function captureBaseline(...)`
- **lines 465-481** (OVERRIDE O16 — the design doc says 466-481; it is 465, because line 465 is the shared `const timestamp = new Date().toISOString();` which must move into the new call site, and the `generation = 1` hardcode is at line 480, not 481): the shared timestamp, the inline `const entries: StateEntryInput[] = adoptable.map(...)`, the `recordDeployments` call, and the `adoptable.forEach(...)` result-stamping loop.

ADD an import:

```ts
import { captureRuntimeBaseline, toBaselineEntry, type RuntimeBaseline } from "../lib/runtime-baseline.js";
```

CHANGE `interface Adoptable` (line 146-149) so `captured` is typed `RuntimeBaseline` instead of `CapturedBaseline`.

CHANGE the call site at line 398 from `await captureBaseline(container, envTool)` to:

```ts
await captureRuntimeBaseline(container, { cwd: process.cwd(), envTool });
```

**OVERRIDE O15:** `cwd: process.cwd()` MUST be passed explicitly. The old `captureBaseline` hardcoded `process.cwd()` internally (import.ts:127-129); the extracted function takes it from the caller. Passing anything else (e.g. a compose project dir) would be a behaviour change. `state rebuild` is the caller that passes a different cwd.

REPLACE the deleted block at 465-481 with:

```ts
const timestamp = new Date().toISOString();
const entries: StateEntryInput[] = adoptable.map((candidate) =>
  toBaselineEntry(candidate.result.service, candidate.captured, timestamp),
);
const ids = recordDeployments(db, entries);
adoptable.forEach((candidate, index) => {
  candidate.result.imported = true;
  candidate.result.deploymentId = ids[index];
  candidate.result.generation = 1;
});
```

Keep the explanatory comment block above it (lines 461-464) verbatim, and keep `candidate.result.generation = 1` — this is a pure refactor; `import`'s candidates provably have `getDeploymentCount === 0`, so #1 is correct there. Do NOT "improve" it to read the assigned generation back.

DROP these now-unused imports (verify with a grep for each symbol before removing):

- `logDebug` from the `@rfmedia/common` import list (line 18)
- `ConfigSnapshot` from `import type { ConfigSnapshot, StateEntryInput } from "../types/state.js";` (line 29) — KEEP `StateEntryInput`, it is still used by the explicit annotation above
- `EnvToolExecConfig` — delete the whole line 28 `import type { EnvToolExecConfig } from "../types/options.js";` (it was only used by `captureBaseline`'s signature). KEEP `getEnvToolExecConfig` from `../types/index.js` on line 27.
- `maskSensitiveEnvVars` from the `../lib/index.js` import list (line 48)
- `inspectContainers`, `inspectContainerIdentity`, `type ContainerInspect`, `type DockerContainerIdentity` from the `../lib/docker.js` import list (lines 55-58) — KEEP `getComposeConfig` and `getRunningServiceContainerMap`
- the entire line 60: `import { parseEnvArray, parsePortBindings } from "../lib/drift.js";`

Do NOT add a compatibility re-export of `buildConfigSnapshotFromInspect` from `import.ts`. Do NOT change any other logic, message string, exit code, or the `getDeploymentCount(db, { service }) > 0` skip at line 395.

### `packages/rfapps-cli/src/actions/import.spec.ts`

Exactly ONE change. Line 62 currently reads:

```ts
import { executeImport, buildConfigSnapshotFromInspect } from "./import.js";
```

Replace it with two lines:

```ts
import { executeImport } from "./import.js";
import { buildConfigSnapshotFromInspect } from "../lib/runtime-baseline.js";
```

**OVERRIDE O9 — the design doc is WRONG and following it would break the suite:** the design says to "move that module into the `vi.mock` bag". DO NOT add `vi.mock("../lib/runtime-baseline.js")`. The test at import.spec.ts:277-292 (`describe("buildConfigSnapshotFromInspect")`) calls the REAL function and asserts the full snapshot shape including `API_KEY: "***MASKED***"` and `ports: ["32400:32400/tcp"]` — mocking the module would stub it out and that assertion would fail. It is also unnecessary: vitest keys mocks on the RESOLVED module path, and `lib/runtime-baseline.ts` imports `./docker.js`, which resolves to the same `src/lib/docker.ts` already partial-mocked at import.spec.ts:54-60. So `captureRuntimeBaseline` is fully controlled by the existing docker mock with zero new mocks.

Make NO other change to the spec. **OVERRIDE O10:** there are NINE `it()` blocks in this file (eight in `describe("executeImport")` at lines 159, 180, 209, 217, 232, 243, 258, 269, plus one at line 278) — the design doc says eight. All nine must pass UNCHANGED; they are the regression proof for the extraction. If any fails, the extraction is wrong — fix `runtime-baseline.ts`'s caller wiring in `import.ts`, do not weaken the test.

When done, run `npx prettier --write packages/rfapps-cli/src/actions/import.ts packages/rfapps-cli/src/actions/import.spec.ts` from the repo root.

## Batch 3

### [T7] actions/state-rebuild.ts + state-rebuild-report.ts + spec (tests 5-8)

**Owns:** packages/rfapps-cli/src/actions/state-rebuild.ts, packages/rfapps-cli/src/actions/state-rebuild-report.ts, packages/rfapps-cli/src/actions/state-rebuild.spec.ts

**Depends on:** T1, T2, T4, T5

**Done when:** `npx vitest run src/actions/state-rebuild.spec.ts` (from packages/rfapps-cli) passes with exactly the four tests 5-8; `npx tsc --noEmit -p packages/rfapps-cli` is clean; neither new source file imports from another `actions/` module; both source files are under ~500 lines.

Implement the rebuild orchestration. Read design.md §Rebuild semantics (208-410), §Safety contract (423-521) and §Error handling (793-817) IN FULL first — this task implements them. Orchestration ONLY: every SQLite/file primitive already exists in `src/lib/state-rebuild.ts` (task T4) and every container observation already exists in `src/lib/runtime-baseline.ts` (task T2). An action must NEVER import another action; do not import from `./import.js`.

### `packages/rfapps-cli/src/actions/state-rebuild.ts` (~300 lines)

```ts
export async function executeStateRebuild(
  rawOptions: RawStateRebuildOptions,
  globalOptions: StateCommandGlobalOptions,
): Promise<void>;
```

**Imports — OVERRIDE O1 (the design doc/verification brief is wrong about this):** `formatOutput` is NOT exported by `@rfmedia/common`. It lives in `src/lib/formatters/index.ts:80` and is re-exported from `src/lib/index.ts:266`. Import it from `../lib/index.js`. From `@rfmedia/common` take only: `logInfo`, `logWarn`, `logSuccess`, `logDebug`, `colors`, `confirm`, `isMachineFormat`, `formatError`, `outputFormattedError`, and `type OutputFormat`. Model the whole import block on `src/actions/import.ts:14-61`.

**Flow (strict order — every step's ordering is a safety property):**

1. `const format: OutputFormat = globalOptions.output ?? (globalOptions.json === true ? "json" : "text");` `const dryRun = globalOptions.dryRun ?? false;` `const yes = globalOptions.yes ?? false;` `const mode = rawOptions.mode ?? "salvage";` `const showUnchanged = rawOptions.showUnchanged ?? false;` `const rewriteRequested = rawOptions.rewrite ?? false;`
2. `if (rewriteRequested && dryRun) { logWarn("--dry-run overrides --rewrite; the state database will not be replaced."); }` then `const willRewrite = rewriteRequested && !dryRun;`
3. `const config = await loadConfig();` then the profile guard exactly as `import.ts:286-293`: `if (rawOptions.profile !== undefined && !isValidProfile(rawOptions.profile, config)) throw new InvalidArgumentError("--profile", rawOptions.profile, "Unknown profile", config.profiles.validProfiles);` then `const finalConfig = applyCliOverrides(config, { composePath: rawOptions.compose, envFile: rawOptions.envFile, profile: ... });`
4. **Authorization guards run BEFORE any Docker, probe, or filesystem work** (mirrors `import.ts:305-320`):
   - `if (willRewrite && finalConfig.state?.enabled === false) throw new InvalidArgumentError("--rewrite", "true", "State tracking is disabled; enable it to rebuild the state database");`
   - `if (willRewrite && mode === "runtime-only" && (rawOptions.confirmProject === undefined || rawOptions.confirmProject.trim() === "")) throw new InvalidArgumentError("--confirm-project", "", "Discarding existing history requires the Compose project name");`
   - `if (willRewrite && isMachineFormat(format) && !yes) throw new InvalidArgumentError("--yes", "false", "Machine-format rebuild requires explicit --rewrite --yes");`
     (the `--confirm-project` MISMATCH check needs the resolved project name, so it lands in step 6.)
     Global `--yes` NEVER grants write authority — it only skips the interactive confirmation in step 12.
5. `const envTool = getEnvToolExecConfig(globalOptions, finalConfig);` and `const profiles = [finalConfig.profiles.defaultProfile];` (`applyCliOverrides` already set `defaultProfile` from `-p`, config.ts:516-521). There is NO `resolveServicesWithInteractive` call — there is no scope to resolve. `state rebuild` has NO `-s/--service`, `--services`, `-g/--group` or `--no-sidecars`.
6. `const identity = await resolveComposeProjectIdentity(finalConfig.composePath, { envFile: finalConfig.envFile, envTool });` (`src/lib/identity.ts:168`) → `{ composePath, projectDir, projectName }`, realpath'd, symlink-free, with `projectName` validated against `/^[a-z0-9][a-z0-9_-]*$/u`. `projectDir` is the `cwd` for EVERY Docker call below. Running from the wrong directory during an additive `import` adds a few rows; during a whole-file replacement it would reconstruct the WRONG project's state.
   **OVERRIDE O14:** `resolveComposeProjectIdentity` throws a plain `Error` ("Compose path does not exist", "Effective Compose project name could not be resolved safely") with NO registered formatter — it hits the generic fallback and yields exit 1. That is acceptable; do not wrap it in a new error class. Also note it ALREADY calls `getComposeConfig` internally (identity.ts:185-190), so a run makes TWO `docker compose config` invocations. Accept that; do not restructure to avoid it.
   Then, if `willRewrite && mode === "runtime-only" && rawOptions.confirmProject !== identity.projectName` → `throw new InvalidArgumentError("--confirm-project", rawOptions.confirmProject ?? "", "Does not match the resolved Compose project", [identity.projectName]);` (the registered formatter renders `Valid values: <projectName>`).
7. `const composeConfig = await getComposeConfig(identity.composePath, { profiles, envFile: finalConfig.envFile, projectName: identity.projectName, envTool, cwd: identity.projectDir });` — `undefined` → emit `formatError(new DockerCommandError("config", "Failed to read Compose configuration", 1, [], false))` through `outputFormattedError`, `setExitCode(ExitCode.OperationalError)`, return. (Copy import.ts:369-379's shape.) `const declared = Object.keys(composeConfig.services).sort();` — this is the DECLARED UNIVERSE.
8. `const observations = await getComposeContainerObservations(identity.composePath, { profiles, envFile: finalConfig.envFile, projectName: identity.projectName, envTool, cwd: identity.projectDir });` (`src/lib/docker.ts:1334`, runs `docker compose ps --all --format json`). This sees created-but-EXITED containers, which `import`'s `ps --status running` cannot — after a host failure most of a stack is exited but still holds recoverable image identity. It throws `DockerIdentityError` on malformed evidence (already formatted → exit 1); let it propagate. If `rawOptions.runningOnly === true`, filter to `observation.state === "running"`. Build `Map<serviceName, observation>`.
9. `const dbPath = getStateDbPath(finalConfig);` — resolved ONCE (`RFAPPS_STATE_DB_PATH` > `config.state.dbPath` > `getDefaultDatabasePath()`, config.ts:648-671). Probe, backup, build and swap ALL use this one value, so it is impossible to back up one file and rewrite another. `const probe = await probeStateDatabase(dbPath);` (never throws). If `probe.isDefaultPath === false`, `logWarn` in the text renderer:
   `Resolved state database <resolved> differs from the default <default>; other rfapps commands read the default path.`
10. Open the source read-only for disposition data: `const source = openReadOnlyStateDatabase(dbPath);` (undefined when missing/corrupt — that is fine, salvage degenerates to runtime-only automatically). `const recordedImageIds = source === undefined ? new Map() : readLatestRecordedImageIds(source);` Keep `source` open for carry-over; close it in the outer `finally`.
11. **Dispositions — evaluate in this EXACT order** per service (union of `declared` ∪ `probe.trackedServices ?? []` ∪ observed service names, iterated sorted lexicographically). Computed against the PROBE's `trackedServices`, never a writable handle:
    1. declared but no observation → `absent`. Zero reconstructed rows.
    2. NOT declared but in `probe.trackedServices` and no observation → `orphaned`. Carried in salvage, dropped in runtime-only. Never rewritten.
    3. observation exists but `await captureRuntimeBaseline(observation.containerName, { cwd: identity.projectDir, envTool })` returned `undefined` → `uninspectable`, `reason: "container inspection failed"`. ZERO rows — it stays reconstructible on retry.
    4. `mode === "salvage"` AND the service has carried deployment rows (i.e. it is in `probe.trackedServices`):
       - `recordedImageIds.get(service)` equals the observed `identity.localImageId` → `carried`.
       - otherwise → `stale`. **Reported, NEVER rewritten.** Appending a fresh baseline would record un-reconciled drift as the service's newest generation, so `rollback` to latest would restore the drift.
         **OVERRIDE O18:** set `reason` to distinguish the two sub-cases, because on a genuine v1/v2 source EVERY carried service lands here (migration v3 deliberately does not backfill `image_id`): when `recordedImageIds.get(service)` is `undefined` use `"no recorded image identity (pre-v3 row)"`; when it is a different string use `"recorded image id differs from runtime"`. Populate `recordedImageId` on the service result either way.
    5. otherwise (no carried history, or `mode === "runtime-only"`) → `reconstructed`. One baseline row appended.
12. Build `summary` (`declared`, `observed`, per-disposition counts, `droppedServices` = services with history in the source that will have NO row in the replacement, `discardedDeployments`, `discardedGenerations` — the latter two are `0` until carry-over runs and MUST always be present so CI can assert the non-destructive property).
13. **Report path.** If `!willRewrite`: build the result with `phase: "report"`, no `backup`, no `carryOver`, `exitCode = resolveStateRebuildExitCode(...)`, emit, return. The report writes NO file — not even a backup — and takes NO state lock (lock acquisition is entirely cli.ts's `preAction`; the action NEVER calls `acquireStateLock`).
14. **Refusal.** If `willRewrite` and the planned replacement would contain ZERO deployment rows (nothing carryable AND nothing `reconstructed`): set `result.refusal = { reason: "empty-plan", message: "..." }`, emit through the NORMAL result path (it is a RESULT, not an exception, so `--json` consumers see it), exit 2 via `resolveStateRebuildExitCode`. Nothing is backed up and nothing is built. Neither "the Docker daemon is down" nor "everything is stopped" may ever be reported as a successful rebuild.
15. **Confirmation.** If `format === "text"` and `!yes`: `await confirm(...)` with the salvage or runtime-only prompt from design.md:451-463 (interpolating carried deployment/generation counts, baseline count, dropped-service count, and the backup path). Declining → `logWarn`, re-render the report, `setExitCode(ExitCode.UsageError)`, return.
16. **Strict order: probe → backup → build replacement → confirm nothing failed → swap.**
    - `const backupPath = defaultBackupPath(dbPath, rawOptions.backupDir, new Date());` then `const backup = await backupStateDatabase(dbPath, backupPath);`. If it THROWS: emit the error through `formatError` + `outputFormattedError`, PRECEDED by an explicit operator line naming the backup path and `"The state database was not modified."`, `setExitCode(ExitCode.OperationalError)`, and return BEFORE a temp database is even created. There is no `--no-backup` and there must never be one.
      (Edge case: when `probe.status === "missing"` there is nothing to back up — skip the backup and leave `result.backup` undefined. Everything else is unchanged.)
    - `const tempPath = buildReplacementDatabasePath(dbPath);` `const target = await initializeDatabase(tempPath);` — `initializeDatabase` is called EXCLUSIVELY on the temp path.
    - `const carryOver = mode === "salvage" && source !== undefined ? carryOverState(source, target, GENERATION_ACTIONS) : { deploymentsCarried: 0, deploymentsDiscarded: 0, generationsCarried: 0, generationsDiscarded: 0, generationsDerived: 0 };` (import `GENERATION_ACTIONS` from `../lib/index.js`).
    - Baseline append: ONE `recordDeployments(target, entries)` call, ONE shared `new Date().toISOString()` timestamp, entries built with `toBaselineEntry(service, baseline, timestamp)` for every `reconstructed` service, sorted lexicographically. `recordDeployments` inserts the deployment and — because `"import"` is in `GENERATION_ACTIONS` — calls `createGeneration()` in the SAME transaction.
    - **Generation numbers are NEVER chosen by this feature.** Read the assigned number back per written service with `getGenerations(target, { service, limit: 1 })[0]?.generation` (that query is `ORDER BY generation DESC` when a service filter is present, generations.ts:154-162) and put it on the service result. Do NOT hardcode `1` — a service carrying generations `1..N` legitimately gets `N+1`.
    - `closeDatabase(target)` (and close `source`) BEFORE the swap.
    - `await swapStateDatabase(tempPath, dbPath);` — TWO arguments (OVERRIDE O3).
    - On ANY throw from the temp-build or swap: `await rm(tempPath, { force: true })` in a `finally`, emit the error via `formatError` + `outputFormattedError` preceded by the operator line naming backup path, temp path and `"The state database was not modified."`, `setExitCode(ExitCode.OperationalError)`.
17. Emit: text → `renderStateRebuildReport(result, showUnchanged)` to stderr; non-text → `await formatOutput(format, result)` to stdout. Then `setExitCode(resolveStateRebuildExitCode(result))` when non-zero. Model the `emit` helper on `import.ts:250-262`.

The envelope is secret-free by construction: service names, image identity, counts, dispositions and paths — NEVER environment values. `configSnapshot` goes into the database (masked by `buildConfigSnapshotFromInspect`) and never into the result.

Nothing read out of `compose.yml` is ever PERSISTED — compose supplies only the ENUMERATION; the container supplies every VALUE. A compose file edited after deployment must not be able to poison a recovered baseline, or `rfapps drift detect` would report zero drift against a fabricated truth.

### `packages/rfapps-cli/src/actions/state-rebuild-report.ts` (~150 lines)

```ts
export function renderStateRebuildReport(result: StateRebuildResult, showUnchanged: boolean): void;
```

Stderr-only text renderer (`logInfo`/`logWarn`/`logSuccess`/`colors` from `@rfmedia/common`). Split out purely to keep both files inside the ~500-line cap. Model its structure on `import.ts`'s `renderReport` (lines 192-250). It must render:

- Database preamble: resolved path, status (`missing`/`readable`/`unreadable` + sanitized `reason`), schema version, integrity, deployment/generation counts, tracked-service count. A loud `logWarn` when `database.isDefaultPath === false`, with the exact message from step 9.
- Per-disposition sections. `reconstructed`, `stale` and `uninspectable` are ALWAYS shown. `carried`, `absent` and `orphaned` are shown only when `showUnchanged` is true (otherwise a one-line count).
- For `stale`, print the `reason` so the two sub-cases from O18 are visible, and a pointer to `rfapps reconcile` / `rfapps deploy`.
- A `History that will be dropped (N)` section listing `summary.droppedServices`.
- Carry-over counts when `result.carryOver` is present, calling out `discardedDeployments` / `discardedGenerations`.
- On a successful rewrite: the backup path, method, and the verbatim restore command:

  ```
  rfapps force-unlock                                    # only if a lock is stuck
  cp <backupPath> <dbPath>
  ```

- The refusal message when `result.refusal` is present.

### `packages/rfapps-cli/src/actions/state-rebuild.spec.ts` — tests 5-8 ONLY

Mocked, copying `src/actions/import.spec.ts`'s style verbatim: a `vi.hoisted(() => ({ ... }))` bag; THREE partial mocks each of the form `async (importOriginal) => ({ ...(await importOriginal<typeof import("...")>()), ...overrides })` for `"@rfmedia/common"`, `"../lib/index.js"` and `"../lib/docker.js"`; `process.exitCode = undefined` in BOTH `beforeEach` and `afterEach`; and a `machineResult()` helper that asserts `formatOutput` was called exactly once and returns `mocks.formatOutput.mock.calls[0]?.[1] as StateRebuildResult` (arg index 1). Assert success with `expect(process.exitCode ?? 0).toBe(0)` and failures with `expect(process.exitCode).toBe(n)`.

Mock at minimum: `loadConfig`, `applyCliOverrides`, `isValidProfile`, `formatOutput`, `initializeDatabase`, `closeDatabase`, `recordDeployments`, `getGenerations`, `getStateDbPath`, `probeStateDatabase`, `openReadOnlyStateDatabase`, `readLatestRecordedImageIds`, `backupStateDatabase`, `defaultBackupPath`, `buildReplacementDatabasePath`, `carryOverState`, `swapStateDatabase`, `captureRuntimeBaseline`, `toBaselineEntry` (from `../lib/index.js`); `getComposeConfig`, `getComposeContainerObservations`, `inspectContainers`, `inspectContainerIdentity` (from `../lib/docker.js`); `confirm`, `isMachineFormat`, `logInfo`/`logWarn`/`logSuccess`/`logDebug`, `outputFormattedError` (from `@rfmedia/common`). Mock `../lib/identity.js`'s `resolveComposeProjectIdentity` too.

5. **Report phase safety.** No `--rewrite`: assert `initializeDatabase`, `backupStateDatabase` and `swapStateDatabase` were NEVER called, and (using a real temp file for `dbPath`) the target file is byte-identical afterwards. Then the same for `--rewrite` under global `--dry-run`, which must ADDITIONALLY produce a `logWarn` containing `--dry-run overrides --rewrite`. These are the two halves of the core safety promise; a regression here destroys a database during a dry run.
6. **Mandatory-backup ordering.** Make `backupStateDatabase` reject. Assert `initializeDatabase` was NEVER called (no temp database was created), `process.exitCode === 1`, and the original file is unchanged. Proves the ordering is real rather than aspirational.
7. **Row semantics + masking + stale.** `--rewrite` (salvage) with two services: one untracked+observed, one tracked whose recorded `image_id` differs from runtime. Assert `recordDeployments` was called ONCE with exactly one entry for the untracked service, whose `action === "import"`, `status === "success"`, `timestamp` is a single shared ISO string, and whose `imageTag`/`imageId`/`imageDigest` are the observed identity triple, and whose `configSnapshot` JSON contains `"***MASKED***"` for a token-shaped env var (drive this through a realistic `inspectContainers` fixture so the REAL `buildConfigSnapshotFromInspect` masking runs, or assert on the `toBaselineEntry` input). Assert the tracked-and-drifted service is `stale` and NO entry was written for it. Assert `summary.droppedServices` is reported.
8. **The two structural gates.** (a) `--mode runtime-only --rewrite` WITHOUT a matching `--confirm-project` rejects with `InvalidArgumentError` and `backupStateDatabase` / `initializeDatabase` were never called. (b) An authorized rewrite whose plan is empty is REFUSED: `machineResult().refusal.reason === "empty-plan"`, `process.exitCode === 2`, and `backupStateDatabase`, `initializeDatabase` and `swapStateDatabase` were all never called.

Do NOT write any other test in this file.

When done, run `npx prettier --write packages/rfapps-cli/src/actions/state-rebuild.ts packages/rfapps-cli/src/actions/state-rebuild-report.ts packages/rfapps-cli/src/actions/state-rebuild.spec.ts` from the repo root.

### [T8] actions/state-export.ts

**Owns:** packages/rfapps-cli/src/actions/state-export.ts

**Depends on:** T1, T4, T5

**Done when:** `packages/rfapps-cli/src/actions/state-export.ts` exports `executeStateExport` with the exact signature, imports `formatOutput` from `../lib/index.js`, never calls `acquireStateLock`, and `npx tsc --noEmit -p packages/rfapps-cli` reports no error in it.

Create `packages/rfapps-cli/src/actions/state-export.ts` (~80 lines). Read design.md's `### rfapps state export` (lines 97-126) and the §Backup subsection (465-484).

```ts
export async function executeStateExport(
  rawOptions: RawStateExportOptions,
  globalOptions: StateCommandGlobalOptions,
): Promise<void>;
```

**Imports — OVERRIDE O1:** `formatOutput` comes from `../lib/index.js` (it is defined in `src/lib/formatters/index.ts:80`), NOT from `@rfmedia/common`. From `@rfmedia/common` take only `logInfo`, `logWarn`, `logSuccess`, `outputFormattedError`, `formatError`, and `type OutputFormat`.

Behaviour:

1. `const format: OutputFormat = globalOptions.output ?? (globalOptions.json === true ? "json" : "text");` `const dryRun = globalOptions.dryRun ?? false;`
2. `const config = await loadConfig();` then `const dbPath = getStateDbPath(config);` — the SAME single-resolution rule as rebuild (`RFAPPS_STATE_DB_PATH` > `config.state.dbPath` > `getDefaultDatabasePath()`).
3. `const probe = await probeStateDatabase(dbPath);` (never throws).
4. `const destination = rawOptions.out ?? defaultBackupPath(dbPath, undefined, new Date());`
5. **Honour global `--dry-run` by reporting the destination and writing NOTHING**: build the result with `dryRun: true`, `backup: undefined`, emit, exit 0.
6. Otherwise `const backup = await backupStateDatabase(dbPath, destination);`. On throw: `outputFormattedError(formatError(error))`, `setExitCode(ExitCode.OperationalError)`, return. (`backupStateDatabase` refuses to overwrite an existing destination, creates the parent `mode: 0o700`, chmods the artifact `0o600`, uses SQLite's online backup API and falls back to a raw byte copy plus `-wal`/`-shm` siblings on a corrupt source.)
7. Result envelope `StateExportResult`: `{ schemaVersion: STATE_EXPORT_SCHEMA_VERSION, operation: "state-export", database: probe, destination, backup?, dryRun, success, exitCode }` with `exitCode = resolveStateExportExitCode(...)`.
8. Emit: text → stderr via `logInfo`/`logSuccess` (destination path, method, byte count, sidecars if any, and the verbatim restore line `cp <destination> <dbPath>`); non-text → `await formatOutput(format, result)` to stdout. Then `setExitCode(result.exitCode)` when non-zero.

**This action NEVER acquires the state lock** — the online backup API is safe under a concurrent writer, and a precautionary backup must not be blocked by a stuck lock. Do not call `acquireStateLock`; lock policy is decided entirely in `cli.ts`'s `preAction` (task T9 makes `state export` lock-free there).

Do NOT create a spec file for this action — the design's critical-test list has no test for `state export`; it is covered by the `state.spec.ts` help smoke test and the shared `lib/state-rebuild.spec.ts` backup tests.

When done, run `npx prettier --write packages/rfapps-cli/src/actions/state-export.ts` from the repo root.

## Batch 4

### [T9] commands/state.ts + spec (test 9) + cli.ts registration and state-lock branch

**Owns:** packages/rfapps-cli/src/commands/state.ts, packages/rfapps-cli/src/commands/state.spec.ts, packages/rfapps-cli/src/cli.ts

**Depends on:** T1, T7, T8

**Done when:** `npx vitest run src/commands/state.spec.ts` (from packages/rfapps-cli) passes; `npm run rfapps -- state rebuild --help` prints the usage line, --mode/--rewrite/--confirm-project and a `Global Options:` section; cli.ts contains the `parentName === "state"` branch between the drift branch and the ALWAYS_MUTATING_COMMANDS check, and `registerStateCommand(program);` in the alphabetical block.

Wire the new nested command group into the CLI. Read design.md §Command surface (66-207) and §State-lock wiring (486-509).

### `packages/rfapps-cli/src/commands/state.ts` (~120 lines)

Combine TWO existing precedents (read both first): `src/commands/drift.ts` is the only nested-group precedent (its subcommand `.action()` handlers forward the ROOT `program.opts()`, not `drift.opts()`); `src/commands/import.ts` supplies the injectable `loadAction()` dependency object, `.configureHelp({ showGlobalOptions: true })`, and the "validate before loading the action module" pattern.

```ts
import { Option, type Command } from "commander";

export interface StateCommandDependencies {
  loadRebuildAction(): Promise<{ executeStateRebuild: ExecuteStateRebuild }>;
  loadExportAction(): Promise<{ executeStateExport: ExecuteStateExport }>;
}

export function validateStateRebuildOptions(options: RawStateRebuildOptions): void;
export function validateStateExportOptions(options: RawStateExportOptions): void;
export function registerStateCommand(
  program: Command,
  dependencies: StateCommandDependencies = defaultDependencies,
): void;
```

with `const defaultDependencies: StateCommandDependencies = { loadRebuildAction: () => import("../actions/state-rebuild.js"), loadExportAction: () => import("../actions/state-export.js") };`

`validateStateRebuildOptions` rejects a blank (whitespace-only) `--confirm-project` and a blank `--backup-dir`; `validateStateExportOptions` rejects a blank `--out`. Copy `import.ts`'s `validateNonBlank` helper shape and throw `InvalidArgumentError` from `../lib/errors.js`. Both run INSIDE the `.action()` handler BEFORE `await dependencies.loadXAction()`.

**Group registration — ORDERING IS LOAD-BEARING (OVERRIDE O6):**

```ts
const state = program
  .command("state")
  .description("Inspect, export, and reconstruct the rfapps state database")
  .configureHelp({ showGlobalOptions: true })   // MUST come before .command(...) below
  .addHelpText("after", `...`);

state.command("export")...
state.command("rebuild")...
```

Commander 14.0.3 copies `_helpConfiguration` into a subcommand at CREATION time (`node_modules/commander/lib/command.js:176` → `copyInheritedSettings` at `:103`). If `.configureHelp(...)` is chained AFTER `state.command("rebuild")` is created, `rfapps state rebuild --help` will NOT print a `Global Options:` section and test 9 fails. Verified empirically.

Group `addHelpText("after", ...)` — verbatim from design.md:89-95:

```
Read-only commands:
  export   Write a consistent, private copy of the state database.

Mutation commands:
  rebuild  Reconstruct the state database from Docker runtime and compose declarations.
```

**`state export`**: `.description("Write a consistent backup copy of the rfapps state database")`, one option `.option("-o, --out <path>", "Backup destination file")`, and the `addHelpText("after", ...)` epilogue verbatim from design.md:109-126 (online-backup rationale, lock-free note, dry-run note, 600/700 permissions and sensitivity note, the `cp` restore line, and the three-row exit-code list).

**`state rebuild`**: `.description("Reconstruct the state database from Docker runtime and compose declarations")` and these options with these EXACT description strings:

**OVERRIDE O2 — the design doc's `--mode` declaration is not valid Commander.** `.option()` returns the `Command`, not the `Option`, so `.choices()` is NOT chainable there. Use `addOption` (precedents: `src/cli.ts:117-119`, `src/commands/init.ts:28-35`):

```ts
.addOption(
  new Option(
    "--mode <mode>",
    "Reconstruction mode (salvage keeps every readable row, runtime-only discards them)",
  )
    .choices(["salvage", "runtime-only"])
    .default("salvage"),
)
```

Then plain `.option(...)` for the rest:

- `--rewrite` → `"Replace the state database with the reconstruction"`, default `false`
- `--confirm-project <name>` → `"Compose project name; required by --mode runtime-only"`
- `--running-only` → `"Only reconstruct services whose container is currently running"`, default `false`
- `--backup-dir <path>` → `"Directory for the mandatory pre-rewrite backup"`
- `--show-unchanged` → `"Include carried, absent, and orphaned services in the report"`, default `false`
- `-f, --compose <path>` → `"Path to Docker Compose file"`
- `-e, --env-file <path>` → `"Path to environment file"`
- `-p, --profile <name>` → `"Docker Compose profile to use"`

Do NOT add `-s/--service`, `--services`, `-g/--group`, or `--no-sidecars`. Scoping a whole-file replacement is incoherent — a scoped rebuild would silently produce a database containing only the scoped services. Per-service work is `rfapps import --adopt -s <svc>`.

`addHelpText("after", ...)` for rebuild: reproduce design.md:152-190 VERBATIM (the "This is NOT `rfapps rebuild`" warning, the report-first paragraph, the mandatory-backup paragraph, the never-mutates/atomic-swap paragraph, the two mode descriptions, the whole-database/no-scope paragraph, and the four-row exit-code list).

Both `.action()` handlers forward the ROOT `program.opts()`:

```ts
.action(async (options: RawStateRebuildOptions) => {
  validateStateRebuildOptions(options);
  const { executeStateRebuild } = await dependencies.loadRebuildAction();
  await executeStateRebuild(options, program.opts());
});
```

### `packages/rfapps-cli/src/cli.ts` — two edits

**(a) Registration — OVERRIDE O7.** The design says "the modular block (lines 288-293)", which is right, but do NOT go looking for `registerDriftCommand` there: it sits alone at line 462. The block at 288-293 is alphabetical (`registerAuditCommand`, `registerDoctorCommand`, `registerForceUnlockCommand`, `registerImportCommand`, `registerReconcileCommand`, `registerUpdateCommand`). Add the import after line 49 (`import { registerReconcileCommand } from "./commands/reconcile.js";`):

```ts
import { registerStateCommand } from "./commands/state.js";
```

and the call between `registerReconcileCommand(program);` and `registerUpdateCommand(program);` to keep alphabetical order.

**(b) State-lock branch.** `resolveStateLockOperation` (lines 74-104) keys on the LEAF command name, and `"rebuild"` is in `ALWAYS_MUTATING_COMMANDS` (lines 62-72). Without a change, a read-only `rfapps state rebuild` report would acquire the global lock labelled `"rebuild"` — indistinguishable from a container rebuild in `force-unlock` output and in the `State lock is held for rebuild by ...` message. Insert this branch IMMEDIATELY AFTER the `if (parentName === "drift") { ... }` block (which ends at line 90) and BEFORE `if (ALWAYS_MUTATING_COMMANDS.has(commandName))` (line 91). That placement is the only one that both preserves drift behaviour and pre-empts the `rebuild` collision:

```ts
if (parentName === "state") {
  return commandName === "rebuild" && options["rewrite"] === true ? "state-rebuild" : undefined;
}
```

(`options` is already in scope from line 84; `opts()` really does carry `rewrite: true` — verified.)

Result: `state export` and report-phase `state rebuild` are lock-free; only an authorized rewrite locks, as `state-rebuild`. Acquisition (lines 243-246) and release (main()'s `finally`, lines 617-634 — OVERRIDE O21, the design says 618-639) stay entirely in cli.ts. The ACTION never calls `acquireStateLock` itself.

Do NOT change anything else in cli.ts.

### `packages/rfapps-cli/src/commands/state.spec.ts` — test 9 ONLY

**OVERRIDE O24:** the precedent is `src/commands/reconcile.spec.ts:169-183`, NOT `update.spec.ts` (which has no spawnSync at all), and NOT the design's literal `spawnSync("node", [..., "src/cli.ts", ...])`. Copy reconcile.spec.ts's exact form:

```ts
const cliPath = fileURLToPath(new URL("../cli.ts", import.meta.url));
const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, "state", "rebuild", "--help"], {
  encoding: "utf8",
});
expect(result.status, result.stderr).toBe(0);
expect(result.stdout).toContain("Usage: rfapps state rebuild [options]");
expect(result.stdout).toContain("--mode");
expect(result.stdout).toContain("--rewrite");
expect(result.stdout).toContain("--confirm-project");
expect(result.stdout).toContain("Global Options:");
```

This is the cheapest possible proof that a brand-new nested command group is actually reachable from the root CLI.

Also add reconcile.spec.ts's companion assertion (`reconcile.spec.ts:67`): an in-process test that registering the group and rendering its help does NOT load the action module — build a `new Command()`, call `registerStateCommand(program, { loadRebuildAction: spy, loadExportAction: spy })`, render help, and assert neither spy was called. That is the point of the injectable `loadAction()`.

Do NOT write any other test in this file.

When done, run `npx prettier --write packages/rfapps-cli/src/commands/state.ts packages/rfapps-cli/src/commands/state.spec.ts packages/rfapps-cli/src/cli.ts` from the repo root.

## Batch 5

### [T10] Spawned-CLI lock-wiring integration test (test 10, rewritten)

**Owns:** packages/rfapps-cli/src/cli.state-rebuild.integration.spec.ts

**Depends on:** T9

**Done when:** `npx vitest run src/cli.state-rebuild.integration.spec.ts` (from packages/rfapps-cli) passes; the spec contains no occurrence of the string `state-rebuild by`; assertion A proves a bare `state rebuild` exits 0 with a lock held.

Create `packages/rfapps-cli/src/cli.state-rebuild.integration.spec.ts` — a spawned real-CLI test using `src/testing/cli-harness.ts`, matching the repo's `cli.<topic>.integration.spec.ts` naming convention. Model it on `src/cli.deploy.integration.spec.ts` test D2a (lines 127-165) — READ THAT TEST FIRST.

**OVERRIDE O8 — the design's test 10 as written CANNOT PASS. Implement the corrected version below and do not restore the original assertion.**

Why the design is wrong: `src/lib/state-lock.ts:446-463` builds the contention message as `State lock is held for ${detail}` where `detail =`${metadata.operation} by ${metadata.who} since ${metadata.when}``, i.e. it interpolates the operation stored in the ALREADY-HELD lock file — never the operation the blocked command requested. The precedent proves it: `cli.deploy.integration.spec.ts:134`writes the fixture lock with`operation: "rebuild"`and then runs`deploy`, and line 148 asserts `"State lock is held for rebuild by other@host"`. A pre-created lock can therefore never surface the string `"state-rebuild"`produced by`resolveStateLockOperation`. Asserting it would fail for ANY correct implementation.

**What to write instead** (one `it()` block, with an explicit `30_000` per-test timeout because it calls `runCli` more than once — the harness default `timeoutMs` is 12_000 and vitest's `testTimeout` is 15_000; see the comment at cli-harness.ts:143-150):

1. `const project = await createFixtureProject();` in `beforeEach`, `await project.cleanup()` in `afterEach`.
2. Pre-create the lock exactly as D2a does — `const lockDirectory = join(project.homeDir, ".rfapps"); const lockPath = join(lockDirectory, "lock"); const lockId = "123e4567-e89b-42d3-a456-426614174000"; await mkdir(lockPath, { recursive: true, mode: 0o700 }); await writeFile(join(lockPath, lockId),`${JSON.stringify({ operation: "deploy", who: "other@host", when: new Date().toISOString(), lockId })}\n`, { mode: 0o600 });` — note `operation: "deploy"`, deliberately chosen so the assertion below is unambiguous about whose label is being rendered.
3. **Assertion A — the report phase is lock-free.** Run `await runCli(["state", "rebuild"], { project, scenario })` with a mock-docker scenario supplying the `config` and `ps --all` responses the report needs (rules matching `{ contains: ["config"] }` and `{ contains: ["ps", "--all"] }`; see `src/testing/mock-docker.ts` for the rule shape and `cli.deploy.integration.spec.ts` for realistic canned stdout). Assert `exitCode === 0` and that `result.invocations.length > 0` (Docker was actually reached). **This is the load-bearing assertion**: `"rebuild"` is in `ALWAYS_MUTATING_COMMANDS` (`cli.ts:62-72`, checked at `:91`), so WITHOUT the `parentName === "state"` branch the report would acquire the lock, be blocked, and exit 1. This is the highest-probability silent bug in the whole change.
4. **Assertion B — the rewrite DOES lock, before any work.** Run `await runCli(["state", "rebuild", "--rewrite", "--yes"], { project, scenario: { rules: [] } })`. Assert `exitCode === 1`, `stderr` contains `"State lock is held for deploy by other@host"` (the FIXTURE's holder label — see the override rationale above), and `invocations` has length `0` (the lock is taken in cli.ts's `preAction`, before any Docker call).

Do NOT assert the literal string `"state-rebuild"` anywhere. If a future task wants to pin that label, it belongs in a unit test of an exported `resolveStateLockOperation`, which is out of scope here.

Do NOT write any other test in this file.

Precondition note: `runCli` spawns `src/cli.ts` via `tsx`, which resolves `@rfmedia/common` through its package `exports` map pointing at `dist/*.js`. If the test cannot resolve `@rfmedia/common`, run `npm run build -w packages/rf-common` first (documented at cli-harness.ts:100-105).

When done, run `npx prettier --write packages/rfapps-cli/src/cli.state-rebuild.integration.spec.ts` from the repo root.

### [T11] Shell completion (bash + zsh + fish) and completion.spec.ts

**Owns:** packages/rfapps-cli/src/actions/completion.ts, packages/rfapps-cli/src/actions/completion.spec.ts

**Depends on:** T9

**Done when:** `npx vitest run src/actions/completion.spec.ts` (from packages/rfapps-cli) passes; `grep -c 'and not __fish_seen_subcommand_from state' packages/rfapps-cli/src/actions/completion.ts` is at least 14; the three `--action` value lists at lines ~209/~639/~1043 are unchanged (no `update` added).

All three completion templates in `packages/rfapps-cli/src/actions/completion.ts` are hand-maintained TypeScript template literals. Note that `$` and backticks inside them are escaped (`\$`, `\``) — match the surrounding escaping exactly when adding lines.

**HARD SCOPE LIMIT — OVERRIDE O5.** The design doc's completion steps bash-5, zsh-3 and fish-3 tell you to add `update` to the `--action` value lists at lines 209, 639 and 1043. **DO NOT DO THAT.** The missing `"update"` in `VALID_ACTIONS` is a real pre-existing bug but is explicitly OUT OF SCOPE for this PR (it will be filed separately). Do not touch those three lines and do not touch `src/actions/history.ts`.

### bash (`generateBashCompletion`, lines 27-360)

1. **Line 40** — append `state` to `local commands="status health pull ... init validate mcp"` (25 entries → 26).
2. **After line 104** (the last `local drift_*_opts` line, `drift_import_opts`) — add a `# State command options` group:

   ```
   local state_export_opts="--out"
   local state_rebuild_opts="--mode --rewrite --confirm-project --running-only --backup-dir --show-unchanged --compose --env-file --profile"
   ```

3. **Line 132** — add `state` to the command-detection `case "\${words[i]}"` pattern list (`status|health|...|validate|mcp)`). Without it the loop falls through and `rfapps state rebuild` is detected as the TOP-LEVEL `rebuild` (verified by simulation).
4. **Lines 134-141** — generalize the drift-only subcommand-detection block so it also captures `export|rebuild` when `\$cmd == "state"`. Keep the existing drift arm byte-identical and add an `elif`:

   ```
   elif [[ "\$cmd" == "state" ]] && [[ \$((i + 1)) -lt \$cword ]]; then
     case "\${words[i+1]}" in
       export|rebuild)
         subcmd="\${words[i+1]}"
         ;;
     esac
   ```

5. **After the `drift)` dispatch block (lines 328-353)** — add a `state)` block of the SAME shape: with no `\$subcmd`, `COMPREPLY` from `\$global_opts` when `\$cur` starts with `-`, else `compgen -W "export rebuild"`; otherwise `case "\$subcmd"` dispatching `export)` → `\$state_export_opts \$global_opts` and `rebuild)` → `\$state_rebuild_opts \$global_opts`.
6. **OVERRIDE O12 — line 196, not a new arm.** The design says to add `--backup-dir|--out)` to the `case "\$prev"` value block. `--out|-o` is ALREADY handled at line 196 (`--compose|-f|--env-file|-e|--use-dotenvx|--use-op|--from-plan|--out|-o)` → `_filedir`); a second `--out)` arm later in the same `case` would be unreachable dead code. Instead EXTEND line 196 to `--compose|-f|--env-file|-e|--use-dotenvx|--use-op|--from-plan|--out|-o|--backup-dir)`.
7. **Also OVERRIDE O12** — add a `--mode)` arm to that same `case "\$prev"` block, in the style of the `--output)` arm at lines 192-195: `COMPREPLY=(\$(compgen -W "salvage runtime-only" -- "\$cur"))`. The design only specified `--mode` value completion for zsh, which would leave the three shells inconsistent, and `completion.spec.ts`'s parity checks compare option NAMES only, so nothing would catch it.

### zsh (`generateZshCompletion`, lines 365-807)

1. **Lines 378-405** — add `'state:Inspect, export, and reconstruct the rfapps state database'` to the `commands` array (25 → 26 entries).
2. **Line 427** — add `state` to `__rfapps_find_command`'s `case`. That helper returns the FIRST matching word (`echo`+`return` at lines 428-429), so without `state` present, `rfapps state rebuild` resolves to the top-level `rebuild` block and renders the wrong `_arguments`.
3. **After the `drift)` case (lines 723-799)** — add a `state)` case of the SAME shape (copy the drift case's structure precisely, it is the template): a local `state_commands=( 'export:Write a consistent backup copy of the rfapps state database' 'rebuild:Reconstruct the state database from Docker runtime and compose declarations' )`, a `__rfapps_find_state_cmd()` helper matching `export|rebuild`, a nested `_arguments -C \${global_opts[@]} '1: :->state_command' '*:: :->state_args'`, and an inner `case \$state in state_command) _describe ... ;; state_args) ... esac` with one `_arguments` block per subcommand.
   In the `rebuild)` arm, `--mode` completes `:mode:(salvage runtime-only)` and `--backup-dir` uses `:directory:_files -/`; in the `export)` arm `--out` uses `:file:_files`.
   **IMPORTANT for the spec (see below):** nested subcommand arms in this file are indented 16 spaces with an 18-space `;;` (compare the nested `import)` arm at line 784 / `;;` at 795), unlike top-level arms which are 8/10. Match the nested indentation exactly.
4. **Do NOT touch line 639.**

### fish (`generateFishCompletion`, lines 812-1148)

1. **After line 886** (the last `__fish_use_subcommand` advertisement, `mcp`) — add:

   ```
   complete -c rfapps -n "__fish_use_subcommand" -a "state" -d "Inspect, export, and reconstruct the rfapps state database"
   ```

2. **Lines 930-943 (the deploy/rebuild option block; the comment is on 929)** — append `; and not __fish_seen_subcommand_from state` to EVERY ONE of those 14 lines. `__fish_seen_subcommand_from` matches by NAME anywhere on the command line, not by position, so today `rfapps state rebuild <TAB>` satisfies `__fish_seen_subcommand_from deploy rebuild` and leaks `--skip-pull`, `--force-recreate`, `--parallel`, `--workers`, `--wait-for-ready`, `--health-timeout`. This block is VERIFIED UNGUARDED today. The guard idiom is already used at lines 1013-1022 (reconcile) and 1024-1033 (import), each carrying `; and not __fish_seen_subcommand_from drift`. No guard is needed for `state export` — there is no top-level `export` command.
3. **After the drift blocks (last drift line is 1146, the template literal closes at 1147)** — add the `state` blocks:
   - subcommand advertisement guarded by `__fish_seen_subcommand_from state; and not __fish_seen_subcommand_from export rebuild`, with `-a "export"` and `-a "rebuild"` (copy the drift pattern at lines 1106-1109);
   - per-subcommand option lines keyed on `__fish_seen_subcommand_from state; and __fish_seen_subcommand_from rebuild` (nine flags: `-l mode` with `-xa "salvage runtime-only"` per OVERRIDE O12, `-l rewrite`, `-l confirm-project`, `-l running-only`, `-l backup-dir`, `-l show-unchanged`, `-s f -l compose`, `-s e -l env-file`, `-s p -l profile -xa "${profiles}"`) and on `__fish_seen_subcommand_from state; and __fish_seen_subcommand_from export` (`-s o -l out`).
4. **Do NOT touch line 1043.**

### `packages/rfapps-cli/src/actions/completion.spec.ts`

1. Add `"state"` to the hardcoded command list at lines 152-178 (25 → 26 entries). The assertion loop at 179-195 checks every shell contains every token.
2. Add a `getStateRebuildCommand()` helper in the shape of `getImportCommand()` (lines 72-78): build `new Command()`, call `registerStateCommand(program, { loadRebuildAction: async () => ({ executeStateRebuild: async () => {} }), loadExportAction: async () => ({ executeStateExport: async () => {} }) })`, find the `state` subcommand, then find its `rebuild` subcommand. Import `registerStateCommand` from `../commands/state.js` alongside the existing `registerImportCommand` import at line 29.
3. Add `getStateRebuildCompletionOptions(shell, script)` in the shape of `getImportCompletionOptions` (lines 83-99):
   - bash: `script.match(/local state_rebuild_opts="([^"]*)"/)?.[1]` → `getLongOptionNames(...)`.
   - **OVERRIDE O13 — zsh regex must NOT be copied verbatim.** `getImportCompletionOptions`'s zsh regex `/\n        import\)\n([\s\S]*?)\n          ;;/` is indentation-coupled to a TOP-LEVEL case arm (8-space arm, 10-space `;;`). The `state rebuild` arm is NESTED (16-space arm, 18-space `;;`). Use `/\n {16}rebuild\)\n([\s\S]*?)\n {18};;/` instead, or the match returns undefined and the helper throws.
   - fish: filter lines containing the guard `"__fish_seen_subcommand_from state; and __fish_seen_subcommand_from rebuild"` then `line.match(/ -l ([a-z][a-z-]*)/)?.[1]`. Note the group-advertisement line uses `state; and not __fish_seen_subcommand_from export rebuild`, which does NOT contain the rebuild-guard substring, so it will not contaminate the filter.
4. Add ONE `it()` asserting Commander parity, modelled on the existing `"keeps import completions in parity with Commander and disjoint from drift import"` test (lines 220-256): derive `commanderOptions` from the registered `state rebuild` command's `option.long?.replace(/^--/, "")`, sorted, and assert `[...new Set(getStateRebuildCompletionOptions(shell, script))].sort()` equals it for every shell. All nine flags have lowercase-with-dash long names, so parity holds.
5. In the SAME `it()`, add the fish disjointness assertion: scan `fish.split("\n")` and for every line containing `__fish_seen_subcommand_from deploy rebuild`, `expect(line).toContain("and not __fish_seen_subcommand_from state")`. Use the existing line-scanning idiom at lines 243-253 as the model.

Do NOT add any other test. Do NOT modify any existing test other than adding `"state"` to the command list array.

When done, run `npx prettier --write packages/rfapps-cli/src/actions/completion.ts packages/rfapps-cli/src/actions/completion.spec.ts` from the repo root.

## Batch 6

### [T12] Full verification sweep

**Owns:**

**Depends on:** T4, T5, T6, T7, T8, T9, T10, T11, D1, D2, D3, D4

**Done when:** `npm run typecheck`, `npm run test:rfapps`, `npm run lint:md` and `npm run format:check` all exit 0; the three `--help` smoke checks print the expected surface; and all three scope-boundary checks confirm history.ts and the `--action` lists were untouched.

Run the full verification suite from the repository root and prove the change is complete and green. Do NOT implement new behaviour in this task; you may only make trivial formatting/lint corrections to files already changed by this PR, or fix an outright defect surfaced by a failing check (in which case fix the root cause — do not weaken a test or add a fallback that hides the failure).

If `@rfmedia/common` fails to resolve in the integration spec, run `npm run build -w packages/rf-common` first (documented precondition in `src/testing/cli-harness.ts:100-105`).

Run, in this order, and record the pass/fail outcome of each:

```bash
npm run typecheck
npm run test:rfapps
npm run lint:md
npm run format:check
```

All four must pass.

- `npm run typecheck` must be clean across rf-common, rfmedia-cli and rfapps-cli. Any `any` introduced by this PR is a defect — fix it by looking up the real type, not by casting.
- `npm run test:rfapps` must be green, and must include: the 4 new tests in `src/lib/state-rebuild.spec.ts`, the 4 in `src/actions/state-rebuild.spec.ts`, the 2 in `src/commands/state.spec.ts`, the 1 in `src/cli.state-rebuild.integration.spec.ts`, the extended `src/actions/completion.spec.ts`, and — critically — all NINE pre-existing tests in `src/actions/import.spec.ts` with no assertion changed (they are the regression proof for the `lib/runtime-baseline.ts` extraction).
- `npm run lint:md` (markdownlint-cli2) must be clean. If it fails, `npx markdownlint-cli2 --fix <only the markdown files this PR changed>` and re-run.
- `npm run format:check` (prettier) must be clean. If it fails, `npx prettier --write <only the files this PR changed>` and re-run. Do NOT run a repo-wide `--write` that reformats untouched files.

Then run these manual smoke checks and confirm the output:

```bash
npm run rfapps -- state --help
npm run rfapps -- state rebuild --help
npm run rfapps -- state export --help
```

- `state rebuild --help` must print `Usage: rfapps state rebuild [options]`, the `--mode`, `--rewrite` and `--confirm-project` flags, and a `Global Options:` section.
- `state rebuild --help` must NOT advertise `-s/--service`, `--services`, `-g/--group` or `--no-sidecars`.

Finally, confirm these scope boundaries were respected (each should produce the stated result):

- `git diff --name-only` does NOT include `packages/rfapps-cli/src/actions/history.ts`.
- `git diff packages/rfapps-cli/src/actions/completion.ts | grep -n 'deploy rebuild delete rollback apply prune import'` shows no change to the three `--action` value lists (no `update` added).
- `grep -rn 'local/share/rfapps' docs/` returns nothing.

Report the exact commands run and their pass/fail outcomes — these go verbatim into the PR's `## Testing` section per the repository's pull-request template.

---

# Critique corrections (C1–C10) — HIGHEST PRECEDENCE

A pre-mortem returned **NEEDS-FIXES**. These corrections override BOTH the design doc AND the task
instructions above. Where any of the three disagree, **this section wins**. Do not "fix" a
correction back toward the earlier wording.

## C1 — Salvage must not crash on a corrupt database (CONFIRMED BUG, blocks the headline use case)

Empirically verified against the installed better-sqlite3 12.6.2:

```
new Database('<corrupt file>', { readonly: true, fileMustExist: true })  -> OPENS SUCCESSFULLY
  .prepare("SELECT name FROM sqlite_master ...").all()                   -> throws SQLITE_NOTADB
  .pragma("integrity_check")                                             -> throws SQLITE_NOTADB
new Database('<missing file>',  { readonly: true, fileMustExist: true }) -> throws SQLITE_CANTOPEN
```

A corrupt source therefore yields a **live handle**, not `undefined`. Without the fix below,
`rfapps state rebuild --rewrite` in the DEFAULT salvage mode throws inside `carryOverState`, unlinks
the temp database, and exits 1 with "The state database was not modified" — recovering nothing on a
`SQLITE_NOTADB` database, which is the primary scenario of issue #150.

Two required changes:

1. **`src/actions/state-rebuild.ts` (T7)** — gate the source handle on the probe, never on the open:

   ```ts
   const source = probe.status === "readable" ? openReadOnlyStateDatabase(dbPath) : undefined;
   ```

   When `source` is `undefined`, skip `carryOverState` entirely and use all-zero `CarryOverCounts`.

2. **`src/lib/state-rebuild.ts` (T4)** — `carryOverState` must wrap the `sqlite_master` table-set
   read in `try`/`catch` and return all-zero counts on any throw. It must never propagate a
   SQLite error to the caller.

Together these make the design's stated behaviour real: _a missing or unreadable source degenerates
salvage into runtime-only automatically_.

## C2 — Test 7 must not mock the masking it asserts (T7)

Test 7 pins secret masking, "the one defect class that would write live credentials". Mocking
`captureRuntimeBaseline` / `toBaselineEntry` means `buildConfigSnapshotFromInspect` never runs and
the assertion tests a stub.

Do **NOT** mock `captureRuntimeBaseline` or `toBaselineEntry`. Mock only `inspectContainers` and
`inspectContainerIdentity` from `../lib/docker.js`, exactly as `src/actions/import.spec.ts:54-60`
already does, and drive the real masking through a realistic `inspectContainers` fixture. This is the
same reasoning override O9 applies to `import.spec.ts`, applied consistently.

## C3 — Actions import lib symbols through the barrel (T7, T8)

`src/actions/state-rebuild.ts` and `src/actions/state-export.ts` MUST import `probeStateDatabase`,
`openReadOnlyStateDatabase`, `readLatestRecordedImageIds`, `backupStateDatabase`,
`defaultBackupPath`, `buildReplacementDatabasePath`, `carryOverState`, `swapStateDatabase`,
`captureRuntimeBaseline`, `toBaselineEntry` and `GENERATION_ACTIONS` from **`../lib/index.js`**.

A `vi.mock("../lib/index.js")` partial mock does not intercept a direct `../lib/state-rebuild.js`
import, so the specs only work if the action goes through the barrel. (`src/actions/import.ts`'s
direct `../lib/runtime-baseline.js` import in T6 is unaffected — its spec does not mock that module.)

## C4 — Backup path must be computed before the confirmation prompt (T7)

Both confirmation prompts end with "A backup will be written to `<backupPath>`", and the salvage
prompt interpolates the carried row counts. Move `defaultBackupPath(...)` **above** the confirm step.
The `<D>` and `<G>` counts in the prompt come from `probe.deployments` and `probe.generations`
(the read-only probe), not from `carryOverState`, which has not run yet.

## C5 — `readLatestRecordedImageIds` fallback SQL is unsound (T4)

The specified `... GROUP BY service HAVING id = MAX(id)` relies on SQLite bare-column resolution and
does not guarantee `image_id` comes from the `MAX(id)` row. This is the ONLY path for v1/v2 sources,
so a wrong value silently flips a service between `carried` and `stale`. Use:

```sql
SELECT service, image_id FROM deployments
WHERE status = 'success'
  AND id IN (SELECT MAX(id) FROM deployments WHERE status = 'success' GROUP BY service)
```

## C6 — Declare the action-function type aliases locally (T9)

`ExecuteStateRebuild` and `ExecuteStateExport` are not defined in `src/types/state-rebuild.ts`.
Declare both as local `type` aliases at the top of `src/commands/state.ts`, mirroring
`src/commands/import.ts:6`.

## C7 — Test 10 needs concrete docker fixtures (T10)

Assertion (a) — bare `rfapps state rebuild` exits 0 with a lock held — requires three docker calls to
return parseable output: `resolveComposeProjectIdentity`'s internal `getComposeConfig`, the action's
own `getComposeConfig`, and `ps --all --format json`. The resolved project name must also match
`/^[a-z0-9][a-z0-9_-]*$/u` or `resolveComposeProjectIdentity` throws a plain `Error` → exit 1.

Specify canned stdout explicitly: a `config` JSON document with a valid lowercase `name` and a
`services` map, and a `ps --all` JSON array whose entries carry `Service`, `Name` and `State`. Assert
exit 0 for the report and exit 1 for `--rewrite --yes`; per override O8, do **not** assert the string
`"state-rebuild"` anywhere.

## C8 — Pin the runbook filename identically (D1, D2, D3)

All three tasks must use exactly `docs/features/rfapps-state-rebuild.md`.

## C9 — Do NOT fix the unrelated stale command list (D3)

`docs/features/shell-completion.md` omits `force-unlock` and `import` from its command list. That is
a pre-existing staleness bug unrelated to #150 — the SAME class the lead carved out in scope
decision 2. **Add only `state`.** Leave `force-unlock` and `import` alone.

## C10 — `--mode` value completion in all three shells is intentional (T11)

The design specified `--mode` value completion (`salvage runtime-only`) for zsh only. Adding the
equivalent to bash (a `--mode)` arm) and fish (`-xa "salvage runtime-only"`) is **approved**: it is
confined to the new command's own completions and three-shell parity is correct behaviour for a
feature we are adding, not a fix to unrelated commands. It will be named in the PR description.

## Ordering and ownership

The pre-mortem found **no ordering violations and no file-ownership conflicts**. Every task's
dependencies resolve to a strictly earlier batch, and the file→task map is disjoint within every
batch. The three soft notes (docs cross-links inside batch 1; transient duplication of
`buildConfigSnapshotFromInspect` between T2 and T6; T12's transitive dependencies) are non-blocking
and require no change.
