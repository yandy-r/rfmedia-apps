<!-- markdownlint-disable MD010 MD031 MD038 -->
<!-- Archived artifact: the hard tabs and the leading/trailing spaces inside code spans are the
     evidence this plan cites (zsh TAB indentation, fish ` -s v`, exact insertion columns), and the
     fences hug their list text on purpose. Normalizing them would destroy the anchors. -->

# Implementation Plan — `rfmedia lidarr audit` (issue #211) — FINAL

**Provenance:** internal planning artifact for [#211](https://github.com/yandy-r/rfmedia-apps/issues/211), captured verbatim from the planning workspace; the absolute design/worktree paths below are historical, and the design referenced throughout is its sibling [design.md](design.md).

**Design:** `/home/yandy/.claude/jobs/74329471/tmp/DESIGN.md` (authoritative for prose/contracts EXCEPT where §1 below overrides).
**Worktree:** `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-issue-211-lidarr-audit`
**Package root for every relative path below:** `packages/rfmedia-cli/` unless the path starts with `docs/`, `ROADMAP.md`, or `package.json`.

**§1 (corrected deltas) OVERRIDES the design wherever they disagree. Read §1, then your task, then §4 (anchors) and §5 (landmines). Do not "improve" beyond your task's `Owns` list.**

---

## 1. Corrected design deltas (verification overrides the design)

### D1 — `--check` has exactly ONE throwing validator, and it is never Commander's

- **Design said:** `parseAuditCheckIds` (Commander `argParser`) throws `InvalidArgumentError`.
- **Actually:** `commander/lib/command.js:599-609` routes a thrown `InvalidArgumentError` into `Command.error()` → `process.exit(1)`; `.action()`, its `try`, and `deps.reportLidarrFailure` never run. In vitest that kills the worker and fails every other test in the file.
- **Do this:**
  1. `parseAuditCheckIds` in `src/commands/lidarr-audit.ts` is a **pure accumulating splitter** that NEVER throws (exact body in **D19**).
  2. The command's pre-flight (inside the action-handler `try`) validates ids against the statically imported `LIDARR_AUDIT_CHECK_IDS` and throws `new LookupNotFoundError("audit check", id, [...LIDARR_AUDIT_CHECK_IDS])`.
  3. `resolveLidarrAuditSelection` in `src/lib/lidarr/audit.ts` ALSO validates (it is a public action-reachable API) and throws the same error.
- **Error class:** `LookupNotFoundError` (`src/lib/errors.ts:189`, constructor `(lookupType, value, availableValues, suggestion?, context?, suggestions?)`), **not** `MissingRequiredArgumentError` — nothing is missing, and `src/lib/error-formatters.ts:155` already renders `LookupNotFoundError` with a `findClosestMatch` "did you mean" suggestion.

### D2 — `shouldFailLidarrAudit` lives in `src/types/lidarr-audit.ts`

- **Design said:** `src/lib/lidarr/audit.ts`.
- **Problem:** the command needs it after rendering; statically importing `src/lib/lidarr/audit.ts` from a command module drags `audit-platform-checks.ts` → `./health.js` → `../db.js` (better-sqlite3) into every `rfmedia` cold start.
- **Do this:** define it in `src/types/lidarr-audit.ts` (pure predicate, no imports). Drop it from `src/lib/lidarr/audit.ts`'s export list.

### D3 — `collectLidarrAuditQueueState` must wrap the COUNT read too

- **Design said:** `countDeferredIntentsByStatus` "never throws"; only `listDeferredIntents` needs a nested try/catch.
- **Actually:** `deferred-queue-db.ts:537-567` has zero error handling; `db.prepare(sql).all(...)` at `:557` propagates any SQLite-level failure (missing table, pre-v10 schema, corrupt file, closed handle).
- **Do this:** OUTER `try/catch` around everything after `openDb()` (fallback: zero-filled counts + `detailUnavailableReason: "cannot read deferred-intent counts: <message>"`), INNER `try/catch` around `listDeferredIntents` only (sets `detailUnavailableReason`, keeps counts), `closeDatabase(db)` in `finally`. The never-throws contract and the degrade-don't-throw test depend on this.

### D4 — Two DB opens per audit run; accept and document

- `readLidarrResilienceSnapshot` opens (`health.ts:390`) and closes (`health.ts:414`) the DB itself and already calls `countDeferredIntentsByStatus(db, origin)` at `health.ts:406`.
- **Do this:** keep the structure; add a JSDoc note on `collectLidarrAuditQueueState`: _"Opens the tracking database twice — once inside `readLidarrResilienceSnapshot`, once here for the full status counts and pending detail. Cheap, and it keeps the snapshot's never-throws guarantee instead of re-deriving circuit state."_ Do NOT restructure to `createSqliteCircuitStore(db)`.

### D5 — Blank artist path counts as unrooted

- `types.ts:364` uses `hasOptionalString`, whose body accepts `""`; the copier at `types.ts:585` only drops `undefined`. `path: ""` survives and is exactly the unrooted case.
- **Do this:** predicate is `artist.path === undefined || artist.path.trim() === ""`.

### D6 — Registry literal form: follow DESIGN §3, NOT the §4 prose

- `tiers.ts:45`/`:66` is `Object.freeze({ … }) satisfies Record<…>` — no `as const`; copying it widens `requires`/`enriches` to mutable arrays and loses literal `id` types.
- **Do this:** `Object.freeze({ … } as const) satisfies Readonly<Record<LidarrAuditCheckId, LidarrAuditCheckDescriptor>>`.

### D7 — `LidarrAuditQueueState.circuits` reuses the resilience type

- **Do this:** `readonly circuits: LidarrResilienceSnapshot["circuits"];` with `import type { LidarrResilienceSnapshot } from "./lidarr-resilience.js";`. Drop the direct `CircuitScope`/`CircuitState` imports.

### D8 — `probeLidarrAuditPlex` must catch non-`MediaServerError` throws

- `resolveRequiredMediaServerAdapter` → `requireMediaServerAdapter` → `createMediaServerAdapter` throws a **plain `Error`** on `invalid-url` (`adapters/index.ts:76-79`) and `cross-origin-override` (`:80-87`, `requiredResolutionError` `:109-120`). Reproducible with `--plex-url http://other:32400` plus a config token: passes the url-AND-token gate, then throws.
- **Do this:** adapter construction goes INSIDE the same `try` as the probe calls; `catch (error)` maps `error instanceof MediaServerError ? error.code : "configuration"`. Never rethrow.
- **Gate values** read exactly as the adapter does: `const config = getLoadedPlexConfig();` (`src/lib/loaded-config.ts:50`) then `overrides.plexUrl ?? config.url`, `overrides.plexToken ?? config.token` (mirrors `adapters/index.ts:70-71`).

### D9 — `.helpGroup()` requires `.addOption(new Option(...))`

- `.helpGroup()` is an `Option` method; all 40 real usages are `.addOption(new Option(...).helpGroup(...))`. Bare `.option()` yields no group. `Command.optionsGroup()` exists in Commander 14.0.3 but has **zero** usages here.
- **Do this:** every audit flag uses `.addOption(new Option("--flag <v>", "desc").helpGroup("Group:"))`, matching `lidarr.ts:943-950`. Do not introduce `optionsGroup()`.

### D10 — zsh insertion line is 413, not 404

- `lidarr_subcmds` is `zsh.ts:407-418`; `:404` is the tail (`${globalOpts}`) of the `mcp)` case; `:413` is the `health` entry; `:414` is `search` (TAB-indented).
- **Do this:** insert immediately after line 413. Do not touch 404.

### D11 — zsh `audit)` block must contain no `<word>)` literal

- `extractZshCaseBlock` (`templates.spec.ts:234-243`) resolves case markers by raw `indexOf` from `script.indexOf("        lidarr)")`. Anything inserted before `search)` must not contain the literals `search)`, `lookup)`, `plan)`, `apply)`, `artist|album)`, `list)`, `status)`, `albums)`, `wanted)`, or any plan-operation `<word>)` — else `templates.spec.ts:470/471/499/585/600` break.
- **Do this:** keep the slot, add the constraint. The value lists ending `plex-alignment)` and `critical)` are safe today; the self-check in T11 proves it.

### D12 — `--allow-stale` omission is correct; the stated reason was wrong

- The parity test at `templates.spec.ts:1079-1112` names only status/list/wanted/health, so a new audit block is invisible to it.
- **Do this:** keep omitting `--allow-stale` (no audit cache; a cached audit is misleading). Drop the "would break the parity test" claim from PR/doc prose. Still add the negative `--allow-stale` assertion to the new exact-option lock test as a forward guard.

### D13 — Absent `releaseDate` is NOT a future release

- `releaseDate?: string` is at `types/lidarr.ts:215` (`:216` is the `foreignAlbumId` doc comment).
- **Do this:** an album with NO `releaseDate` stays **eligible as a gap**. Only `Date.parse(releaseDate) > now` excludes.

### D14 — Doc-reference corrections (cite these, not the design's numbers)

| Design cite                                                       | Correct cite                                                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `FETCH_CALL_PATTERN` "regex at check-direct-plex-imports.mjs:543" | declared at `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs:115`, applied at `:543` |
| `LidarrSuccessActionResult` at `lidarr.ts:394`                    | `:395` (`:394` is its JSDoc)                                                                    |
| health report-not-gate test at `lidarr.test.ts:1947`              | `:1948-1966` (`:1947` is blank)                                                                 |
| stdout-purity assertion at `lidarr.test.ts:678-683`               | spy setup `:682`; assertion pattern to copy `:2169-2174`                                        |
| "No import of `src/lib/plex`, `src/lib/plex-cache`"               | `LEGACY_PLEX_MODULES` has FOUR: also `src/lib/plex-filter-evaluator`, `src/lib/plex-pagination` |
| "the bare word `fetch` is fatal"                                  | pattern is `/\b(?:fetch\|trustedFetch)\s*\(/g` — only a call-paren match trips it               |

### D15 — Action resolves the client INSIDE the `runSingle` callback

- `actions/lidarr/health.ts:63-73` resolves the client inside the `run` callback, keeping client-resolution failures inside the scheduler's execution-metadata envelope.
- **Do this:** resolve `origin` via `resolveRequiredLidarrOrigin(overrides)` (`lib/lidarr/index.ts:146`) BEFORE scheduling (queue/Plex gathers need it); resolve the client via `resolveRequiredLidarrClient(...)` (`lib/lidarr/index.ts:265`) INSIDE the `run` callback.

### D16 — `audit-queue.ts` imports `LidarrClientOverrides` from `./health.js`

- The type exists twice, identically, at `src/lib/lidarr/health.ts:301` and `src/lib/lidarr/index.ts:47`. A lib module MUST use `import type { LidarrClientOverrides } from "./health.js";` — the barrel would pull `export * from "./plan-engine.js"` etc. into the queue module (DESIGN §8 non-goal 7).

### D17 — Finding codes are a frozen, typed, per-check contract (NEW)

- **Problem:** DESIGN names only ~9 of the finding `code` strings, yet calls them a public contract that T12/T15 must assert and document. Three agents would invent their own.
- **Do this:** `src/types/lidarr-audit.ts` (T1) exports a frozen tuple + derived type, and `LidarrAuditFinding.code` is typed `LidarrAuditFindingCode` (not `string`). `LidarrAuditCheckDescriptor` gains `readonly findingCodes: readonly LidarrAuditFindingCode[]`. Exact, complete, frozen set (23 codes):

  | Check                 | Codes                                                                                                                                           |
  | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
  | `metadata-dependency` | `lidarr-unreachable`, `metadata-provider-outage`                                                                                                |
  | `operation-safety`    | `lidarr-health-check`, `artist-missing-root-path`                                                                                               |
  | `retry-backlog`       | `circuit-open`, `circuit-half-open`, `circuit-state-unknown`, `deferred-intents-failed`, `deferred-intents-pending`, `queue-detail-unavailable` |
  | `monitoring-drift`    | `monitored-album-under-unmonitored-artist`, `monitored-artist-no-monitored-albums`                                                              |
  | `library-gaps`        | `artist-monitored-no-files`, `wanted-backlog`, `album-monitored-no-files`, `album-partial-files`                                                |
  | `duplicate-identity`  | `duplicate-artist-mbid`, `duplicate-artist-path`, `similar-artist-name`, `duplicate-album-mbid`                                                 |
  | `plex-connectivity`   | `plex-unreachable`, `plex-no-music-library`, `plex-library-name-unresolved`                                                                     |
  | `plex-alignment`      | _(none — `findingCodes: []`)_                                                                                                                   |

  T12 asserts: every emitted finding's `code` is in `LIDARR_AUDIT_CHECK_DESCRIPTORS[finding.checkId].findingCodes`, and the flat tuple is exactly the union of the per-check lists with no duplicates.

### D18 — The dead-`--fail-on` pre-flight is REMOVED (NEW)

- **Design said:** pre-flight #3 throws `OptionConflictError` when max `descriptor.maxSeverity` over the selection is below the gate.
- **Actually:** `shouldFailLidarrAudit` (D2) returns `true` for `report.status === "degraded"` at ANY non-`none` level regardless of severity rank. `--check monitoring-drift --fail-on critical` is therefore a **live** gate (a `check-error` or `data-unavailable` slot trips it). The pre-flight would reject a legitimate invocation.
- **Do this:** delete pre-flight #3 entirely. `src/commands/lidarr-audit.ts` imports neither `OptionConflictError` nor uses `maxSeverity`. Only two pre-flight failures exist (unknown `--check` id; `--artist-ids` without `--deep`). `maxSeverity` stays in the registry (documentation/rendering only). The feature doc must state that a `--fail-on` level above a selection's `maxSeverity` still trips on `degraded`.

### D19 — `--check` accumulates; zsh advertises it repeatable (NEW)

- **Conflict:** DESIGN §4 spells the zsh entry `'*--check[…]'` (repeatable) while §5 declares a single comma-list `--check <ids>`. With a non-accumulating parser, `--check a --check b` silently drops `a`, and `extractZshCaseOptions` cannot catch it.
- **Do this:** the parser accumulates, so both forms work:

  ```ts
  export function parseAuditCheckIds(value: string, previous?: readonly string[]): string[] {
    const parsed = value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    return [...(previous ?? []), ...parsed];
  }
  ```

  zsh keeps `'*--check[Run only these checks (repeatable, comma-separated)]:check:(…)'`. Bash/fish offer the value list. `resolveLidarrAuditSelection` dedupes and re-orders to registry order.

### D20 — `runHealthProbe` carries no failure reason; `health` slot stays `available` (NEW)

- **Actually:** `health.ts:126-133` returns `{ status: "unreachable", checkedAt, errors: [], warnings: [], metadataProvider: { available: true, failingChecks: [] } }` — the `LidarrError` is swallowed and `LidarrHealthReport` (`health.ts:53-73`) has no reason/message field. "Mark slots with the probe's reason" is unimplementable.
- **Do this:**
  1. T1 exports the exact constant:
     `export const LIDARR_AUDIT_UNREACHABLE_DETAIL = "Lidarr is unreachable; the health probe failed at the transport level";`
  2. On `report.status === "unreachable"` the action sets `artists`, `wanted`, `albums` to `{ status: "unavailable", reason: "data-unavailable", detail: LIDARR_AUDIT_UNREACHABLE_DETAIL }` and issues no further Lidarr reads.
  3. **The `health` slot STAYS `available` with the unreachable report as its data** — that report is the evidence `metadata-dependency` needs to emit the `lidarr-unreachable` critical finding. Gating it out would produce a `degraded` report with no explanatory finding. T13 asserts this explicitly.

### D21 — `LidarrAuditCoverage` semantics are fixed (NEW)

Exactly these rules in `runLidarrAudit` (no others):

| Field             | Rule                                                                               |
| ----------------- | ---------------------------------------------------------------------------------- |
| `artistsExamined` | `gathered.artists.status === "available" ? gathered.artists.data.length : 0`       |
| `albumsExamined`  | `gathered.albums.status === "available" ? gathered.albums.data.albums.length : 0`  |
| `artistsScanned`  | `gathered.albums.status === "available" ? gathered.albums.data.artistsScanned : 0` |
| `wantedTotal`     | `gathered.wanted.status === "available" ? gathered.wanted.data.total : null`       |

Coverage is computed from slot availability alone — never from the selection.

### D22 — One shared finding factory in `src/types/lidarr-audit.ts` (NEW)

- **Problem:** T5 (batch 2) and T7 (batch 3) both must cap `subjects` and set `affected`; two agents, two files, no shared code ⇒ divergent semantics for group findings.
- **Do this:** T1 exports the single factory every evaluator uses:

  ```ts
  export function createLidarrAuditFinding(input: {
    readonly checkId: LidarrAuditCheckId;
    readonly code: LidarrAuditFindingCode;
    readonly severity: LidarrAuditSeverity;
    readonly summary: string;
    readonly subjects: readonly LidarrAuditSubject[];
    readonly affected?: number;
    readonly evidence?: Readonly<Record<string, string | number | boolean>>;
    readonly remediation: LidarrAuditRemediation;
  }): LidarrAuditFinding;
  ```

  Semantics (frozen): `subjects` is truncated to the first `LIDARR_AUDIT_MAX_SUBJECTS` entries; `affected` defaults to `input.subjects.length` (the count BEFORE truncation); `evidence` defaults to `{}`; the returned object and its `subjects`/`evidence` are `Object.freeze`d.
  **`affected` always counts affected ENTITIES, never groups.** For group-based findings (`duplicate-artist-mbid`, `duplicate-artist-path`, `similar-artist-name`, `duplicate-album-mbid`) the evaluator emits **one finding per group**, `subjects` = that group's members, `affected` = `members.length`, and `evidence.groupSize` = `members.length`.

### D23 — fish verbose must be `-s v -l verbose` (NEW)

- `extractFishOptions` (`templates.spec.ts:245-254`) derives `-v` only from ` -s ([a-z])`. Every existing fish `-v` line uses the full form (e.g. `fish.ts:1379`).
- **Do this:** the fish audit verbose line is `… -s v -l verbose -d "…"` (no `-r`). A `-l verbose`-only line fails the T11 lock test.

### D24 — Completion value lists are bound to the registry by test (NEW)

- T11 hardcodes the 8 check ids and 4 fail levels in bash, zsh, fish, and the spec; the source of truth is `LIDARR_AUDIT_CHECK_IDS` / `LIDARR_AUDIT_FAIL_ON_LEVELS` in `src/types/lidarr-audit.ts`.
- **Do this:** `templates.spec.ts` imports those two consts (the module is type-only-importing and side-effect free, so the existing no-network/no-adapter import guards stay green) and asserts the bash/zsh/fish value lists equal them. T11 therefore **depends on T1**.

### D25 — Deep mode issues `listArtists` twice; do not "optimize" it away (NEW)

- `scanSelectedArtists` (`album-scan.ts:118-133`) performs its own `client.listArtists()` and returns only `{ albums, artistNames, artistsScanned, execution }` — never the artist list, and it narrows to `--artist-ids`.
- **Do this:** the action still fetches the library-wide artist list inside `runSingle` for the `artists` slot (`operation-safety` / `duplicate-identity` need library-wide data). Accept the one extra request in `--deep` mode, note it in a code comment and in the feature doc's cost table. Do NOT feed the scan's data into the `artists` slot.

---

## 2. Task DAG

**Concurrency rule for every batch:** package-wide gates (`npx tsc --noEmit`, `npm run check:architecture`) are **NOT** per-task acceptance criteria while siblings are still writing files. Each task's acceptance uses the _own-file_ filter shown in its section. The full gates run once per batch in the **Batch close gate**, executed serially by the orchestrator after every task in the batch reports done.

**Own-file typecheck idiom** (safe under concurrency — must print nothing):

```bash
cd packages/rfmedia-cli && npx tsc --noEmit 2>&1 | grep -F "<your/own/file.ts>"
```

---

### Batch 1 — contract

#### **T1 — Audit type contract, registry, and pure helpers**

- **Owns (exclusive):** `packages/rfmedia-cli/src/types/lidarr-audit.ts` (new)
- **Depends on:** —
- **Scope:** DESIGN §3's first code block verbatim, with these deltas:
  - **D6** registry form: `Object.freeze({ … } as const) satisfies Readonly<Record<LidarrAuditCheckId, LidarrAuditCheckDescriptor>>`.
  - **D7** `LidarrAuditQueueState.circuits` → `readonly circuits: LidarrResilienceSnapshot["circuits"];` via `import type { LidarrResilienceSnapshot } from "./lidarr-resilience.js";`; drop the direct `CircuitScope`/`CircuitState` imports.
  - **D17** add:
    ```ts
    export const LIDARR_AUDIT_FINDING_CODES = [
      /* all 23, in check order */
    ] as const;
    export type LidarrAuditFindingCode = (typeof LIDARR_AUDIT_FINDING_CODES)[number];
    ```
    Narrow `LidarrAuditFinding.code` to `LidarrAuditFindingCode`. Add `readonly findingCodes: readonly LidarrAuditFindingCode[]` to `LidarrAuditCheckDescriptor` and populate every descriptor per the D17 table (`plex-alignment` gets `[]`).
  - **D2** export
    ```ts
    export function shouldFailLidarrAudit(report: LidarrAuditReport, failOn: LidarrAuditFailOn): boolean;
    ```
    Exhaustive semantics, no other rules:
    ```
    failOn === "none"                             -> false
    report.status === "degraded"                  -> true
    summary.highestSeverity === "none"            -> false
    rank(summary.highestSeverity) >= rank(failOn) -> true, else false
    ```
    `rank` = index in `LIDARR_AUDIT_SEVERITIES` (`info`=0, `warning`=1, `critical`=2).
  - **D22** export `createLidarrAuditFinding` with exactly the documented capping/`affected`/freezing semantics, including the "one finding per group, `affected` = member count" rule in its JSDoc.
  - **D20** export `export const LIDARR_AUDIT_UNREACHABLE_DETAIL = "Lidarr is unreachable; the health probe failed at the transport level";`
  - Replace the inline `import("./lidarr.js").LidarrAlbum` / `import("../lib/lidarr/health.js").LidarrHealthReport` type expressions with top-level `import type` statements (precedent: `types/lidarr-resilience.ts:15`).
  - Keep `DbLidarrDeferredIntentStatus` from `../lib/lidarr/deferred-queue-db.js` (exported at `:23`) and `MediaServerErrorCode` / `MediaServerLibrary` from `./media-server.js` — all `import type`.
  - **Zero value imports.** The command layer and `templates.spec.ts` import this module for free.
- **Acceptance:**
  ```bash
  cd packages/rfmedia-cli
  npx tsc --noEmit 2>&1 | grep -F "src/types/lidarr-audit.ts"     # prints nothing
  grep -n '^import' src/types/lidarr-audit.ts                      # only `import type` lines
  ```
- **Batch close gate:** `cd packages/rfmedia-cli && npx tsc --noEmit`

---

### Batch 2 — leaf modules (T2–T6 in parallel; all depend on T1 only)

#### **T2 — Identity folding + duplicate grouping**

- **Owns:** `packages/rfmedia-cli/src/lib/lidarr/audit-identity.ts` (new)
- **Depends on:** T1
- **Scope:** DESIGN §3 second code block — `foldArtistName`, `normalizeArtistPath`, `LidarrAuditDuplicateGroup<T>`, `groupDuplicates<T>`.
  - `foldArtistName`: `normalizeForMatch(name)` (`../fuzzy-match.js:55`) → `.normalize("NFKD").replace(/\p{M}/gu, "")` → leading-article strip (`the |a |an ` prefix). Returns `""` when nothing survives. Do NOT use `findBestMatch` (it emits `logDebug` per pairwise comparison, `fuzzy-match.ts:185`).
  - `normalizeArtistPath`: collapse duplicate `/` separators, strip trailing separators, **CASE-SENSITIVE** (Linux bind mounts). `""` for blank input.
  - `groupDuplicates`: O(n) `Map` bucketing; `keyOf` returning `undefined` **or** `""` excludes the item; returns only groups with `members.length >= 2`, ordered by first appearance, `Object.freeze`d.
- **Acceptance:** own-file typecheck clean; `grep -nE '\b(fetch|trustedFetch)\s*\(' src/lib/lidarr/audit-identity.ts` prints nothing; no I/O imports.

#### **T3 — Queue state collector (the only DB access)**

- **Owns:** `packages/rfmedia-cli/src/lib/lidarr/audit-queue.ts` (new)
- **Depends on:** T1
- **Scope:** DESIGN §3 `audit-queue.ts` block — `collectLidarrAuditQueueState(overrides, origin, deps?)`.
  - **D16:** `import type { LidarrClientOverrides } from "./health.js";` (never `./index.js`).
  - Value imports: `readLidarrResilienceSnapshot` from `./health.js`; `countDeferredIntentsByStatus` from `./deferred-queue-db.js` (`:537`); `listDeferredIntents` from `./deferred-queue.js` (`:322`); `initializeDatabase` (`../db.js:233`) and `closeDatabase` (`../db.js:2036`).
  - `LidarrAuditQueueDependencies { readonly openDb?: () => Promise<DbConnection> }` mirroring `health.ts:308-312`; default `deps?.openDb ?? ((): Promise<DbConnection> => initializeDatabase())` (`health.ts:387`).
  - **D3** control flow (exact):
    ```
    circuits <- (await readLidarrResilienceSnapshot(overrides)).circuits    // never throws
    db <- try openDb() catch -> return { circuits, counts: ZERO_COUNTS,
             detailUnavailableReason: `cannot open tracking database: ${message}` }
    try {
      counts <- countDeferredIntentsByStatus(db, origin)                    // covered by OUTER try
      try {
        pending <- listDeferredIntents(db, { status: "pending", origin, limit: 500 })
        derive oldestPendingAgeSeconds / overdue / nearExhaustion
      } catch -> detailUnavailableReason = `cannot read deferred-intent detail: ${message}`
    } catch -> counts = ZERO_COUNTS,
               detailUnavailableReason = `cannot read deferred-intent counts: ${message}`
    finally { closeDatabase(db); }
    ```
    `ZERO_COUNTS = { pending: 0, "in-progress": 0, succeeded: 0, failed: 0, cancelled: 0 }`.
  - Derivations: `oldestPendingAgeSeconds` from `createdAt`; `overdue` = `nextAttemptAt !== null && Date.parse(nextAttemptAt) <= now`; `nearExhaustion` = `attempts >= maxAttempts - 1`. All optional; omitted when the detail read failed.
  - **D4** JSDoc note about the two DB opens.
  - The function must be **structurally incapable of throwing**.
- **Acceptance:** own-file typecheck clean; `grep -nE '\b(fetch|trustedFetch)\s*\(' src/lib/lidarr/audit-queue.ts` prints nothing.

#### **T4 — Plex probe (sole adapter boundary)**

- **Owns:** `packages/rfmedia-cli/src/actions/lidarr/audit-plex.ts` (new)
- **Depends on:** T1
- **Scope:** DESIGN §3 `audit-plex.ts` block + §2 row 7.
  - Allowed imports, and nothing else Plex-shaped: `resolveRequiredMediaServerAdapter` from `../../lib/adapters/action-helpers.js` (`:38`); `MediaServerError` + types from `../../types/media-server.js`; `getLoadedPlexConfig` from `../../lib/loaded-config.js` (`:50`); types from `../../types/lidarr-audit.js`.
  - **D8** shape:
    ```ts
    const config = getLoadedPlexConfig();
    const url = overrides.plexUrl ?? config.url;
    const token = overrides.plexToken ?? config.token;
    if (url === undefined || url === "" || token === undefined || token === "") {
      return { status: "unavailable", reason: "plex-not-configured", detail: "…" };
    }
    try {
      const adapter = resolveRequiredMediaServerAdapter({ plexUrl: url, plexToken: token });
      const libraries = await adapter.library.list();
      // optional configured-name resolution in its own inner try/catch
      return { status: "available", data: { reachable: true, libraries, … } };
    } catch (error) {
      const code = error instanceof MediaServerError ? error.code : "configuration";
      return { status: "available", data: { reachable: false, code, message: message(error) } };
    }
    ```
    Adapter construction is INSIDE the try. Never rethrow.
  - `adapter.library.byName()` failure message is surfaced **verbatim** as `resolutionDetail` (it already embeds `Available: <titles>`, `query-library.ts:429`).
- **Acceptance:** own-file typecheck clean; `grep -nE '\b(fetch|trustedFetch)\s*\(' src/actions/lidarr/audit-plex.ts` prints nothing; `grep -nE "lib/plex|adapters/plex|types/plex" src/actions/lidarr/audit-plex.ts` prints nothing.

#### **T5 — Platform evaluators**

- **Owns:** `packages/rfmedia-cli/src/lib/lidarr/audit-platform-checks.ts` (new)
- **Depends on:** T1
- **Scope:** DESIGN §2 rows 1, 2, 3, 7 + §3. Four pure synchronous exports with signature `(g: LidarrAuditGatheredData) => readonly LidarrAuditFinding[]`: `evaluateMetadataDependency`, `evaluateOperationSafety`, `evaluateRetryBacklog`, `evaluatePlexConnectivity`. Zero I/O, zero client imports.
  - Only lib import: `detectMetadataProviderOutage` from `./health.js` (`:91`) — reused verbatim so `operation-safety` can exclude every check `metadata-dependency` already claims.
  - **Every finding is built with `createLidarrAuditFinding` (D22); every `code` comes from the D17 table.**
  - Exhaustive `LidarrHealthType → LidarrAuditSeverity` switch with a `const exhaustive: never` default: `error→critical`, `warning→warning`, `notice→info`, `ok→not emitted` (`LidarrHealthType` is a closed 4-arm union, `types/lidarr.ts:352`).
  - `metadata-dependency`: (a) `report.status === "unreachable"` → one `critical` `lidarr-unreachable`; (b) each `metadataProvider.failingChecks` entry → `critical` `metadata-provider-outage`, `remediation.docUrl = check.wikiUrl` **unmodified**, `remediation.command = "rfmedia lidarr health --type error"`.
  - `operation-safety`: (a) translated non-metadata health checks → `lidarr-health-check`; (b) **D5** unrooted artists → `artist-missing-root-path` (warning).
  - `retry-backlog`: (a) circuit `open` → `circuit-open` critical with `retryAtIso`; `half-open` → `circuit-half-open` warning; (b) `{ state: "unknown", reason }` → `circuit-state-unknown` **info**, reason quoted verbatim, never treated as healthy; (c) `counts.failed > 0` → `deferred-intents-failed` critical; (d) `counts.pending > 0` → `deferred-intents-pending` warning with `oldestPendingAgeSeconds`/`overdue`/`nearExhaustion` in `evidence`; (e) `detailUnavailableReason` present → `queue-detail-unavailable` **info** quoting it.
  - `evaluatePlexConnectivity`: `reachable:false` → `plex-unreachable`, severity `critical` for codes `authentication|authorization|network|timeout`, else `warning`. `reachable:true && libraries.length === 0` → `plex-no-music-library` warning. `configuredLibraryResolved === false` → `plex-library-name-unresolved` warning with `evidence.available` = the verbatim `resolutionDetail`.
  - Every `remediation.command` is a read command or a `lidarr plan …` command (test-enforced).
- **Acceptance:** own-file typecheck clean; `grep -nE '\b(fetch|trustedFetch)\s*\(' src/lib/lidarr/audit-platform-checks.ts` prints nothing.

#### **T6 — Audit test fixtures (new helper module)**

- **Owns:** `packages/rfmedia-cli/src/actions/test-helpers/lidarr-audit-fixtures.ts` (new — do NOT edit the existing `lidarr-fixtures.ts`)
- **Depends on:** T1
- **Scope:** the builders T12/T13 need and that `lidarr-fixtures.ts` does not provide (it has only `createLidarrArtistStatisticsFixture:55`, `createLidarrArtistFixture:73`, `createLidarrAlbumFixture:169`, `createLidarrHealthCheckFixture:213`). Export exactly:
  - `createLidarrHealthReportFixture(overrides?: Partial<LidarrHealthReport>): LidarrHealthReport` — defaults `{ status: "healthy", checkedAt: "2026-07-25T00:00:00.000Z", errors: [], warnings: [], metadataProvider: { available: true, failingChecks: [] } }`.
  - `createLidarrAuditQueueStateFixture(overrides?: Partial<LidarrAuditQueueState>): LidarrAuditQueueState` — defaults: both circuits `closed`, all five counts `0`.
  - `createLidarrAuditPlexProbeFixture(overrides?: Partial<Extract<LidarrAuditPlexProbe, { reachable: true }>>): LidarrAuditPlexProbe` — default reachable with one music library.
  - `availableSlot<T>(data: T): LidarrAuditSlot<T>` and `unavailableSlot(reason: LidarrAuditUnavailableReason, detail: string): LidarrAuditSlot<never>`.
  - `createLidarrAuditGatheredDataFixture(overrides?: Partial<LidarrAuditGatheredData>): LidarrAuditGatheredData` — every slot `available` with empty/healthy data except `plexIdentity`, which is `unavailable`/`identity-mapping-unavailable`.
  - Types imported from `../../types/lidarr-audit.js` and `../../lib/lidarr/health.js` (type-only). Re-export nothing from `lidarr-fixtures.ts`.
- **Acceptance:** own-file typecheck clean. (File name contains no `.test.`/`.spec.`, so it IS scanned by the architecture check — keep it import-clean: no `fetch(`, no Plex modules.)

#### **Batch 2 close gate** (orchestrator, serial)

```bash
cd packages/rfmedia-cli && npx tsc --noEmit && npm run check:architecture
```

---

### Batch 3 — library evaluators

#### **T7 — Library evaluators**

- **Owns:** `packages/rfmedia-cli/src/lib/lidarr/audit-library-checks.ts` (new)
- **Depends on:** T1, T2
- **Scope:** DESIGN §2 rows 4, 5, 6 + §3. Three pure synchronous exports: `evaluateMonitoringDrift`, `evaluateLibraryGaps`, `evaluateDuplicateIdentity`.
  - Imports: `filterLidarrAlbums` from `./album-selection.js` (`:50`) — reused because its private `albumHasFiles` (`:35-37`) already encodes "absent statistics counts as zero files"; `foldArtistName`/`normalizeArtistPath`/`groupDuplicates` from `./audit-identity.js`; types from `../../types/lidarr-audit.js` and `../../types/lidarr.js`. `album-selection.ts` is NOT in the barrel, so this import is cycle-free.
  - **All findings via `createLidarrAuditFinding` (D22); codes from the D17 table.**
  - `monitoring-drift`: (a) `monitored-album-under-unmonitored-artist` → **warning**; (b) `monitored-artist-no-monitored-albums` → **info** (message must state that stock "Monitor: Future" produces this and it is frequently intentional). Commands are `rfmedia lidarr plan artist-monitoring …` / `rfmedia lidarr plan album-monitoring …` with `--plan-file`; `rfmedia lidarr apply <file>` appears in **`action` prose only**.
  - `library-gaps`: (a) `artist-monitored-no-files` warning — `statistics.trackCount > 0 && statistics.trackFileCount === 0`; (b) `wanted-backlog` info from `wanted.data.total`, message states the total is library-wide and ignores `--artist-ids`; (c) `album-monitored-no-files` warning (deep only) via `filterLidarrAlbums(albums, { monitored: true, hasFiles: false })` excluding future releases — **D13**: absent `releaseDate` stays eligible; (d) `album-partial-files` info — `0 < trackFileCount < trackCount`.
    Do NOT compute percent-of-tracks coverage (DESIGN §2 deferred table: `trackCount` and `trackFileCount` have different scopes).
  - `duplicate-identity`: (a) `duplicate-artist-mbid` critical via `groupDuplicates(artists, a => a.foreignArtistId)`; (b) `duplicate-artist-path` warning via `normalizeArtistPath` (blank ⇒ excluded); (c) `similar-artist-name` info via `foldArtistName`, restricted to groups with **distinct** `foreignArtistId`s, labelled a candidate not a verdict; (d) `duplicate-album-mbid` info (deep only) via `groupDuplicates(albums, a => a.foreignAlbumId)` — optional field, `undefined` excludes.
    Deletion is named in **`action` prose only** (`rfmedia lidarr plan artist-delete`); `remediation.command` is `rfmedia lidarr lookup artist "lidarr:<mbid>"` / `rfmedia lidarr list`.
  - **One finding per duplicate group** (D22); `evidence.groupSize` = member count.
  - `noUncheckedIndexedAccess` is ON — every `artistsById.get(album.artistId)` is `T | undefined`; guard each one.
- **Acceptance:** own-file typecheck clean; `grep -nE '\b(fetch|trustedFetch)\s*\(' src/lib/lidarr/audit-library-checks.ts` prints nothing.
- **Batch close gate:** `cd packages/rfmedia-cli && npx tsc --noEmit && npm run check:architecture`

---

### Batch 4 — engine

#### **T8 — Audit engine**

- **Owns:** `packages/rfmedia-cli/src/lib/lidarr/audit.ts` (new)
- **Depends on:** T1, T5, T7
- **Scope:** DESIGN §3 engine block + §6.
  - Exports: `LidarrAuditRunInput`, `runLidarrAudit`, `resolveLidarrAuditSelection`, `resolveLidarrAuditRequirements`. **`shouldFailLidarrAudit` is NOT here** (D2).
  - `EVALUATORS: Readonly<Record<LidarrAuditEvaluatedCheckId, LidarrAuditEvaluator>>` — keyed on `Exclude<LidarrAuditCheckId, LidarrAuditReservedCheckId>` so `plex-alignment` has no unreachable body and a missing evaluator is a compile error.
  - `runLidarrAudit`:
    - Iterates `LIDARR_AUDIT_CHECK_IDS` in declaration order; EVERY registered check appears in `report.checks` exactly once, always.
    - Not in `input.selected` → `skipped` / `not-selected`.
    - Reserved id → `skipped` with `identity-mapping-unavailable` (or `plex-not-configured` when the `plex` slot itself is unavailable for that reason), detail naming #207/#208. **Never** dispatches an evaluator.
    - Requirement gate: any `requires` entry whose slot is `unavailable` → `skipped` with **that slot's own** `reason` and `detail`. `enriches` never gates.
    - Per-check `try/catch` → `skipped` / `check-error` with the message as `detail`; every other check still runs.
    - Status precedence: `degraded` (any `data-unavailable` slot consumed by a selected check, or any `check-error`) > `findings` > `clean`. `not-requested` / `requires-deep` / `plex-not-configured` / `identity-mapping-unavailable` / `not-selected` NEVER degrade.
    - Builds `summary` (counts + `checksRun`/`checksSkipped` + `highestSeverity`) and `coverage` per **D21**; deep-freezes the report.
  - `resolveLidarrAuditSelection(raw)`: `undefined` → all ids in registry order; otherwise validate each against `LIDARR_AUDIT_CHECK_IDS` and throw `new LookupNotFoundError("audit check", id, [...LIDARR_AUDIT_CHECK_IDS])` (D1) from `../errors.js`; returns deduped ids in registry order.
  - `resolveLidarrAuditRequirements(selected)`: union of `requires` → `required`; union of `enriches` minus `required` → `enriched`.
  - **MUST NOT statically import `./index.js`.**
- **Acceptance:** own-file typecheck clean; `grep -n 'from "./index.js"' src/lib/lidarr/audit.ts` prints nothing.
- **Batch close gate:** `cd packages/rfmedia-cli && npx tsc --noEmit && npm run check:architecture`

---

### Batch 5 — action layer

#### **T9 — Audit action + barrel export**

- **Owns:** `packages/rfmedia-cli/src/actions/lidarr/audit.ts` (new), `packages/rfmedia-cli/src/actions/lidarr/index.ts` (modify)
- **Depends on:** T3, T4, T8
- **Scope:** DESIGN §3 action block + §6.
  - `export const TIER: LidarrTier = "local-only";` (mirrors `actions/lidarr/health.ts:22`).
  - **Fetch plan first:** `selected = resolveLidarrAuditSelection(options.check)`; `{ required, enriched } = resolveLidarrAuditRequirements(selected)`. Drop `albums` when `--deep` is off (slot → `requires-deep`); drop `plex` when credentials are absent (slot → `plex-not-configured`, produced by `probeLidarrAuditPlex`); `plexIdentity` is a compile-time constant `unavailable` / `identity-mapping-unavailable`. Every unplanned requirement → `not-requested`.
  - **D15:** resolve `origin` via `resolveRequiredLidarrOrigin(overrides)` before scheduling; resolve the client via `resolveRequiredLidarrClient({ lidarrUrl, lidarrApiKey }, { tier: TIER, retryAttemptsOverride: 0 })` **inside** the `run` callback.
  - Exactly ONE `runSingle(TIER, { id: "lidarr-audit", operation: "lidarr audit", idempotent: true, run })` wraps the Lidarr HTTP gather; it always exists (zero-request when nothing Lidarr-backed is planned) so `execution` is deterministic.
  - Inside `run`, when any Lidarr HTTP requirement is planned: `runHealthProbe(client)` FIRST (reachability pre-check + `health` slot data). **D20:** on `status === "unreachable"`, keep the `health` slot **available** with that report, set `artists`/`wanted`/`albums` to `unavailable`/`data-unavailable` with `LIDARR_AUDIT_UNREACHABLE_DETAIL`, and issue no further Lidarr reads. Otherwise `client.listArtists()` when `artists` is planned and `client.getWantedMissing({ page: 1, pageSize: 1 })` → `.totalRecords` when `wanted` is planned.
  - **Outside** the `runSingle` task (nesting would hold one of the lane's 8 slots — `albums.ts:130-171` precedent):
    - `scanSelectedArtists(client, artistIds, { taskIdPrefix: "lidarr-audit-albums", operationLabel: "lidarr audit album scan" })` when `albums` is planned. **D25:** this issues its own `listArtists`; do not reuse its data for the `artists` slot — add a code comment saying so.
    - `collectLidarrAuditQueueState(overrides, origin)` when `queue` is planned.
    - `probeLidarrAuditPlex({ plexUrl, plexToken })` when `plex` is planned.
  - `scanSelectedArtists` rejection **propagates** (fail-closed). The thrown `LidarrPlanValidationError` context must name BOTH escape hatches: `--artist-ids` scoping and the `lidarr.scheduler.lanes.local-only.operationBudget` config override.
  - Delegate to `runLidarrAudit({ checkedAt, origin, deep, selected: new Set(selected), gathered })`; return `{ execution, report }`; deep-freeze.
  - Barrel edit: two lines, house pattern (§4 anchors).
- **Acceptance:**
  ```bash
  cd packages/rfmedia-cli && npx tsc --noEmit && npm run check:architecture
  ```
  (T9 is alone in its batch, so full gates are safe here.)

---

### Batch 6 — command layer + completions (T10 ∥ T11; disjoint files)

#### **T10 — Audit command leaf + registration + order pin**

- **Owns:** `packages/rfmedia-cli/src/commands/lidarr-audit.ts` (new), `packages/rfmedia-cli/src/commands/lidarr.ts` (modify), `packages/rfmedia-cli/src/commands/lidarr.test.ts` (modify, 1 line)
- **Depends on:** T9
- **Scope:** DESIGN §3 command block + §5, with **D1**, **D2**, **D9**, **D18**, **D19**.
  - `createLidarrAuditCommand(deps: LidarrAuditCommandDeps): Command` — DI factory, imports **nothing** from `./lidarr.js`. `LidarrAuditCommandDeps` is byte-compatible with `LidarrSearchCommandDeps` (`lidarr-search.ts:38-50`) plus `parseIdList`.
  - **Frozen flag set** (identical to T11's; any change requires editing both tasks):

    | Flag                     | helpGroup     | parser / choices                                       | Description (byte-identical across command, zsh, fish) |
    | ------------------------ | ------------- | ------------------------------------------------------ | ------------------------------------------------------ |
    | `--check <ids>`          | `Selection:`  | `parseAuditCheckIds` (D19, accumulating, never throws) | `Run only these checks (repeatable, comma-separated)`  |
    | `--deep`                 | `Selection:`  | boolean                                                | `Include per-artist album scan (1 + N requests)`       |
    | `--artist-ids <ids>`     | `Selection:`  | `deps.parseIdList("Artist", value)`                    | `Restrict the deep album scan to these artist IDs`     |
    | `--fail-on <level>`      | `Safety:`     | `.choices(["none","info","warning","critical"])`       | `Exit 1 when findings reach this severity`             |
    | `-v, --verbose`          | `Output:`     | boolean                                                | `Show every finding subject in human output`           |
    | `--lidarr-url <url>`     | `Connection:` | —                                                      | `Lidarr server URL`                                    |
    | `--lidarr-api-key <key>` | `Connection:` | —                                                      | `Lidarr API key`                                       |
    | `--plex-url <url>`       | `Connection:` | —                                                      | `Plex server URL`                                      |
    | `--plex-token <token>`   | `Connection:` | —                                                      | `Plex API token`                                       |

    Every one of these is declared with `.addOption(new Option(...).helpGroup(...))` (**D9**).

  - Verbose is read locally (`cmdOptions["verbose"] === true`) — `resolveVerbose` is module-local to `lidarr.ts` and is NOT injected.
  - Pre-flight validation — exactly TWO checks, both inside the action-handler `try` so they flow through `deps.reportLidarrFailure`:
    1. `--artist-ids` without `--deep` → `new MissingRequiredArgumentError("--artist-ids requires --deep", "lidarr audit")`.
    2. Unknown `--check` id → `new LookupNotFoundError("audit check", id, [...LIDARR_AUDIT_CHECK_IDS])` (D1).
       **D18: there is no third (dead-`--fail-on`) check.** Do not import `OptionConflictError`.
  - Static imports from `../types/lidarr-audit.js` only (registry, `LIDARR_AUDIT_*` consts, `shouldFailLidarrAudit`). Action via `await import("../actions/lidarr/index.js")`.
  - Output: machine → `formatOutput` (`../lib/formatters/index.js:73`); json/yaml with 2 args `("json", { command: "lidarr-audit", result })`; csv with 3 args and `{ columns: [...LIDARR_AUDIT_CSV_COLUMNS] }` (the spread is REQUIRED — `FormatOptions.columns?: string[]` is mutable). Human → `console.error` only, in DESIGN §5's 7-step order. Nothing writes to `console.log`.
  - Exit gate applied AFTER rendering: `if (shouldFailLidarrAudit(result.report, failOn)) { process.exitCode = 1; }`. `process.exit()` is never called.
  - Failure path: `await deps.reportLidarrFailure("audit", error, { staleHint: false, format, sensitiveValues: [cmdOptions["lidarrApiKey"], cmdOptions["plexToken"]] })`. `plexToken` is new and mandatory. `reportLidarrFailure` takes `subcommand: string` — `LidarrSuccessCommand` needs no change.
  - `lidarr.ts`: one import line + one `addCommand` between `:1435` and `:1436`. Do NOT touch `LidarrSuccessCommand` (`:387`), `LidarrSuccessActionResult` (`:395`), or `projectLidarrCsvSuccess` (`:409`).
  - `lidarr.test.ts:735`: insert `"audit",` after `"health",`.
  - `noPropertyAccessFromIndexSignature` is ON — every Commander option read is `cmdOptions["failOn"] as string | undefined`.

- **Acceptance:**
  ```bash
  cd packages/rfmedia-cli && npx tsc --noEmit 2>&1 | grep -F "src/commands/"     # prints nothing
  env -u FORCE_COLOR npx vitest run src/commands/lidarr.test.ts                  # green
  # from repo root (rfmedia is only on PATH after `npm run link`):
  npm run rfmedia -- lidarr audit --help                                          # shows Selection:/Safety:/Output:/Connection: groups
  ```

#### **T11 — Shell completions (three templates + spec, one commit)**

- **Owns:** `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`, `zsh.ts`, `fish.ts`, `templates.spec.ts`
- **Depends on:** T1 (registry ids/levels — **D24**)
- **Scope:** DESIGN §4 Modify rows, with **D10**, **D11**, **D12**, **D19**, **D23**, **D24**. Flag set and descriptions are exactly T10's table above. Check ids: the 8 in `LIDARR_AUDIT_CHECK_IDS`. Fail levels: `none info warning critical`.
  - **bash.ts** — 4 edits (§4 anchors): add `audit` after `health` on `:159`; add three single-line vars in the `:160-181` block:
    ```
    local lidarr_audit_opts="--check --deep --artist-ids --fail-on --plex-url --plex-token -v --verbose"
    local lidarr_audit_checks="metadata-dependency operation-safety retry-backlog monitoring-drift library-gaps duplicate-identity plex-connectivity plex-alignment"
    local lidarr_audit_fail_levels="none info warning critical"
    ```
    a **dedicated guarded** word-scanner arm modelled on `albums)` (`:203-208`) — bash `case` is first-match-wins and `audit` appears in no existing arm; a dispatch arm between `:530` and `:531` handling `--check` → `$lidarr_audit_checks` and `--fail-on` → `$lidarr_audit_fail_levels` via `$prev`, else `"$lidarr_audit_opts $lidarr_shared_opts $global_opts"`.
    - Vars MUST stay single-line (`extractBashCandidates`, `templates.spec.ts:213-217`, does `match[1].split(" ")`).
    - Do NOT reuse `$lidarr_search_opts` (`templates.spec.ts:494-496` pins its occurrence count at exactly 2).
    - Do NOT add `$prev` arms for `--artist-ids`/`--plex-url`/`--plex-token` inside the audit branch — they are intercepted early at `bash.ts:306-309` and would be dead code.
  - **zsh.ts** — 2 edits: `'audit:Audit Lidarr library health and drift'` inserted after line **413**; a new flat `audit)` `_arguments` case between `health)`'s closing `;;` (`:483`) and `search)` (`:484`), ending with `${globalOpts}`.
    - `--check` uses the repeatable form `'*--check[Run only these checks (repeatable, comma-separated)]:check:(metadata-dependency … plex-alignment)' \` (**D19**).
    - `-v` MUST use the house form `'(-v --verbose)'{-v,--verbose}'[Show every finding subject in human output]' \` — `extractZshCaseOptions` (`templates.spec.ts:230`) only detects `-v` via the literal `{-v,--verbose}`.
    - **D11:** no `<word>)` literal anywhere in the block; no `--flag` token in any description that is not in the frozen flag set (the extractor regex `/--[a-z][a-z-]*/gu` would pick it up).
  - **fish.ts** — 3 edits: `__fish_rfmedia_lidarr_audit_active` predicate copied from `:1139-1147`; the advertisement line immediately after `:1292` (order matters for `templates.spec.ts:424-429`); a `# Lidarr audit options` block after `:1348` and before `# Lidarr search options` (`:1350`). Every value-taking flag carries `-r`; `--check` and `--fail-on` additionally carry `-xa "<values>"`; verbose is `-s v -l verbose` (**D23**, no `-r`); `--deep` takes no `-r`. Descriptions byte-identical to zsh.
  - **templates.spec.ts** — 5 edits:
    1. `lidarrCommandTree.lidarr` at `:42` gains `"audit"` at index 5 (after `"health"`).
    2. A `lidarrAuditOptions` const after `lidarrSearchOptions` (`:61-67`):
       `["--check","--deep","--artist-ids","--fail-on","--plex-url","--plex-token","-v","--verbose","--lidarr-url","--lidarr-api-key"]`.
    3. A new exact-option lock test modelled verbatim on `:541-567`, including the negative `--allow-stale` assertion (**D12**) and — unlike albums — a **positive** `-v` assertion.
    4. **D24 registry-binding assertions** in that same test:
       ```ts
       import { LIDARR_AUDIT_CHECK_IDS, LIDARR_AUDIT_FAIL_ON_LEVELS } from "../../types/lidarr-audit.js";
       expect(extractBashCandidates(bashScript, "lidarr_audit_checks")).toEqual([...LIDARR_AUDIT_CHECK_IDS]);
       expect(extractBashCandidates(bashScript, "lidarr_audit_fail_levels")).toEqual([...LIDARR_AUDIT_FAIL_ON_LEVELS]);
       ```
       plus zsh and fish equivalents. Add one new local helper next to `extractZshCaseOptions`:
       ```ts
       function extractZshOptionValues(script: string, command: string, option: string): string[] {
         const block = extractZshCaseBlock(script, command);
         const match = block.match(new RegExp(`'\\*?${option}\\[[^\\]]*\\]:[a-z-]+:\\(([^)]*)\\)'`, "u"));
         expect(match, `missing Zsh ${option} values for ${command}`).not.toBeNull();
         return match?.[1]?.split(" ").filter(Boolean) ?? [];
       }
       ```
       Fish values via `extractFishOptionLine(script, "__fish_rfmedia_lidarr_audit_active", "check")` containing `-xa "<ids joined by space>"`.
    5. An `__fish_rfmedia_lidarr_audit_active` entry in `valueOptionsByCondition` (`:787-901`) listing `["check","artist-ids","fail-on","plex-url","plex-token","lidarr-url","lidarr-api-key"]` (NOT `deep`, NOT `verbose` — neither takes a value).
  - Do NOT add scheduler-tuning flags (`templates.spec.ts:903-910` bans them).
- **Acceptance:**
  ```bash
  cd packages/rfmedia-cli
  env -u FORCE_COLOR npx vitest run src/lib/shell-completions/templates.spec.ts   # fully green
  # D11 self-check — must print nothing:
  npx tsx -e 'import {generateZshCompletion} from "./src/lib/shell-completions/zsh.js";
    const s=generateZshCompletion(); const a=s.indexOf("audit)"); const e=s.indexOf("search)",a);
    const b=s.slice(a,e);
    for (const m of ["status)","list)","albums)","wanted)","health)","search)","lookup)","plan)","apply)","artist|album)"])
      if (b.includes(m)) console.log("FORBIDDEN MARKER:",m);'
  ```

#### **Batch 6 close gate** (orchestrator, serial)

```bash
cd packages/rfmedia-cli && npx tsc --noEmit && npm run check:architecture
# Cross-check the frozen flag set against the real Commander tree:
cd <repo-root> && npm run rfmedia -- lidarr audit --help
# every flag printed must appear in templates.spec.ts's lidarrAuditOptions, and vice versa
```

---

### Batch 7 — tests (T12 ∥ T13 ∥ T14)

**Applies to all three:** DESIGN §7 forbids these files — do NOT create them: a standalone `audit-identity.test.ts`, an `audit-queue.test.ts` against real SQLite, an `audit-plex.test.ts`, renderer snapshot tests, or a duplicate of the subcommand-order assertion. Exactly three new test files ship. Every vitest invocation is prefixed `env -u FORCE_COLOR`.

#### **T12 — Engine + evaluator test suite**

- **Owns:** `packages/rfmedia-cli/src/lib/lidarr/audit.test.ts` (new)
- **Depends on:** T8, T6
- **Scope:** DESIGN §7 file 1 — every bullet. Pure data in, pure report out, **no mocks**. Fixtures from `src/actions/test-helpers/lidarr-fixtures.ts` (`createLidarrArtistFixture:73`, `createLidarrAlbumFixture:169`, `createLidarrHealthCheckFixture:213`, `createLidarrArtistStatisticsFixture:55`) and `src/actions/test-helpers/lidarr-audit-fixtures.ts` (T6).
  - Required cases: registry integrity (ids unique, kebab-case, every id present, `findingCodes` union equals `LIDARR_AUDIT_FINDING_CODES` with no duplicates — **D17**); requirement gating propagates the slot's own `reason` + `detail`; **`plex-alignment` always skips with `identity-mapping-unavailable` even when the `plex` slot is available** (the #208 regression guard); per-check error isolation → `degraded` with all other checks still run; status precedence; `coverage` field-by-field per **D21** including `wantedTotal === null` for a `not-requested` wanted slot; the full `shouldFailLidarrAudit` matrix (`none|info|warning|critical` × clean/findings/degraded — imported from `../../types/lidarr-audit.js`, D2), explicitly including **`--fail-on critical` + `degraded` ⇒ true** (D18's justification); `resolveLidarrAuditSelection` rejects an unknown id with `LookupNotFoundError`; `resolveLidarrAuditRequirements` hard/soft split; subject capping (25 subjects → `subjects.length === 10`, `affected === 25`).
  - Trap tests: `groupDuplicates` excludes `undefined` and `""` keys; `foldArtistName` collapses case + **diacritics** ("Björk" ≡ "Bjork") + punctuation + leading article, and equal folded names with distinct MBIDs produce **info** not critical; `normalizeArtistPath` is **case-sensitive** (`/music/Artist` vs `/music/artist` do NOT collide); absent `statistics` counts as zero files; a **future** `releaseDate` is not a gap **and an ABSENT `releaseDate` IS still eligible** (**D13**); `operation-safety` does not re-report metadata-outage checks; the 4-arm `LidarrHealthType` map is total; `wikiUrl` reaches `remediation.docUrl` unmodified; `retry-backlog` surfaces `{state:"unknown",reason}` and `detailUnavailableReason` as **info**, never healthy; **blank-string artist path is flagged as unrooted** (**D5**); Plex probe union → finding mapping for `reachable:false`, zero libraries, unresolved library name.
  - **Code-contract sweep (D17):** across every evaluator and fixture, assert each finding's `code` ∈ `LIDARR_AUDIT_CHECK_DESCRIPTORS[finding.checkId].findingCodes`.
  - **Non-mutating remediation invariant:** sweep every finding from every evaluator and assert no `remediation.command` matches `/lidarr apply|[-\s]delete\b/`.
- **Acceptance:** `cd packages/rfmedia-cli && env -u FORCE_COLOR npx vitest run src/lib/lidarr/audit.test.ts` green.

#### **T13 — Action cost & safety contract test**

- **Owns:** `packages/rfmedia-cli/src/actions/lidarr/audit.test.ts` (new)
- **Depends on:** T9, T6
- **Scope:** DESIGN §7 file 2. Copy the mock harness from `src/actions/lidarr/health.test.ts:1-45` (`vi.hoisted` before `vi.mock`, pass-through `runSingle` stub, `createLidarrClientMock()` from `../test-helpers/lidarr-client-mocks.js`, SUT imported after all mocks, `vi.clearAllMocks()` in `beforeEach` — `vi.resetAllMocks()` is banned).
  - The `vi.mock("../../lib/lidarr/index.js", …)` factory must export **`resolveRequiredLidarrOrigin`** in addition to `resolveLidarrScheduler` + `resolveRequiredLidarrClient` (health.test.ts stubs only the latter two).
  - Also mock `./album-scan.js`, `./audit-plex.js`, `../../lib/lidarr/health.js`, `../../lib/lidarr/audit-queue.js`, `../../lib/loaded-config.js`.
  - Assertions: scheduler called with `("local-only", objectContaining({ id: "lidarr-audit", idempotent: true }))`; overrides reach `resolveRequiredLidarrClient` as `(objectContaining({ lidarrUrl, lidarrApiKey }), objectContaining({ tier: "local-only", retryAttemptsOverride: 0 }))`; **`--check retry-backlog` invokes neither `scanSelectedArtists` nor `client.listArtists` nor `runHealthProbe`**; `--check monitoring-drift` without `--deep` yields a `requires-deep` `albums` slot and no scan; a rejecting `scanSelectedArtists` **propagates**; **`runHealthProbe` returning `status:"unreachable"` leaves the `health` slot `available` with that report while `artists`/`wanted` become `data-unavailable` with `LIDARR_AUDIT_UNREACHABLE_DETAIL`, and no further Lidarr reads occur** (**D20**); absent Plex credentials yield `plex-not-configured` with no adapter construction; secret-leak guards `expect(inspect(result)).not.toContain("secret-api-key")` and the same for a Plex token (`health.test.ts:752` precedent).
- **Acceptance:** `cd packages/rfmedia-cli && env -u FORCE_COLOR npx vitest run src/actions/lidarr/audit.test.ts` green.

#### **T14 — Command / CI contract test**

- **Owns:** `packages/rfmedia-cli/src/commands/lidarr-audit.test.ts` (new)
- **Depends on:** T10
- **Scope:** DESIGN §7 file 3.
  - **Harness (do not improvise):** import `lidarrCommand` from `./lidarr.js` and build the `rootCommand` harness copied verbatim from `src/commands/lidarr.test.ts:685-699`, including the `--json`→`--output` preAction reconciliation at `:692-697`, because `resolveFormat()` reads `lidarrCommand.parent?.opts()` and a standalone parse silently degrades to `"text"`.
  - **Mock all five modules that `lidarr.test.ts:644-648` mocks** — `../actions/lidarr/index.js`, `../lib/logger.js`, `../lib/formatters/index.js`, `../lib/prompt.js`, `../lib/lidarr/plan-engine.js` — otherwise importing `lidarrCommand` pulls real implementations.
  - Spy `console.log` and `console.error` (`lidarr.test.ts:682` pattern); `afterEach` resets `process.exitCode = undefined` (`lidarr.test.ts:705`).
  - **Never pass an invalid `--fail-on` value.** `.choices()` routes through `Command.error()` → `process.exit(1)` exactly like `InvalidArgumentError` (landmine 19). If such a case is ever wanted, wrap with `armCommanderThrow` (`lidarr.test.ts:1974`).
  - Exit-code matrix: default run with a critical finding leaves `process.exitCode` **undefined** (report-not-gate contract — mirror `lidarr.test.ts:1948-1966`, **D14**); `--fail-on warning` + critical finding → 1; `--fail-on critical` + only warnings → untouched; `--fail-on critical` + `degraded` report → 1 (**D18**); `--fail-on none` never sets it.
  - `--output json` → `formatOutput` called with exactly two args `("json", { command: "lidarr-audit", result })`, plus `expect(consoleLogSpy).not.toHaveBeenCalled()` stdout purity (copy `lidarr.test.ts:2169-2174`, **D14**).
  - `--output csv` → three args with `{ columns: [...LIDARR_AUDIT_CSV_COLUMNS] }`, rows in `summary` → `check` → `finding` order.
  - Pre-flight failures produce the failure envelope + `process.exitCode === 1` **before** the action mock is called, for **both** cases (D18 removed the third): unknown `--check` id, and `--artist-ids` without `--deep`.
  - `--check a --check b` and `--check a,b` produce the same selection (**D19**).
  - API key and Plex token absent from failure output.
- **Acceptance:** `cd packages/rfmedia-cli && env -u FORCE_COLOR npx vitest run src/commands/lidarr-audit.test.ts` green.

#### **Batch 7 close gate**

```bash
cd packages/rfmedia-cli && env -u FORCE_COLOR npm run test:run
```

---

### Batch 8 — documentation (T15 ∥ T16 ∥ T17)

#### **T15 — Feature doc + package README**

- **Owns:** `packages/rfmedia-cli/docs/features/lidarr-audit.md` (new), `packages/rfmedia-cli/README.md` (modify)
- **Depends on:** T10
- **Scope:**
  - `docs/features/lidarr-audit.md` (~210 lines), modelled on `docs/features/lidarr-albums.md`. Must cover: the 8-check catalog with severities, **the D17 finding codes per check**, and remediation; the severity ladder and its deliberate distinction from `LidarrRiskLevel` / `LidarrHealthType`; `--check` fetch-plan economics (`retry-backlog` = 0 requests, `duplicate-identity` = 2) **and D25's extra `listArtists` in `--deep` mode**; the fail-closed deep scan with **both** escape hatches named (`--artist-ids`, `lidarr.scheduler.lanes.local-only.operationBudget`); the full JSON schema (copy DESIGN §3's worked example); the CSV row schema; the exit-code table (DESIGN §5) **including D18's note that `--fail-on <level>` still trips on a `degraded` report even when no selected check can emit `<level>`**; the CI recipe `rfmedia lidarr audit --output json --fail-on warning | jq -r '.result.report.summary.highestSeverity'`; the reserved `plex-alignment` slot and why (#207/#208, no join key); and a "deliberately rejected" section carrying the `albumCount` drift and percent-of-tracks rejections so #208's implementer does not reach for them.
  - `README.md`: new `### Lidarr Library Health Audit` section between `### Lidarr Albums` (`:4947`) and `### Lidarr Mutation Plan/Apply` (`:4975`), ending with the conventional `See [Lidarr Library Health Audit](docs/features/lidarr-audit.md) …` pointer; plus one `## Features` bullet (list begins at `:5`; there is currently no Lidarr bullet — add one).
  - Markdown: headings surrounded by blank lines; markdownlint-clean.
- **Acceptance:** `npm run lint:md` from repo root passes.

#### **T16 — Repo docs index, CHANGELOG, ROADMAP, roadmap archive**

- **Owns:** `docs/README.md`, `packages/rfmedia-cli/CHANGELOG.md`, `ROADMAP.md`, `docs/roadmap-archive.md` (all modify)
- **Depends on:** T10
- **Scope:**
  - `docs/README.md`: one bullet in the Lidarr feature-doc list (§4 anchors), matching the two-line wrapped style of its neighbours.
  - `packages/rfmedia-cli/CHANGELOG.md`: one bullet under the existing `### Added` at `:18` (inside `## [Unreleased]`, after `### Changed` at `:10`). Do not create a new section.
  - `ROADMAP.md` — five coordinated edits:
    1. `:8` `**Last updated:**` → today's date.
    2. `:10` `**Open issues:** 93 (rfapps 40 · rfmedia 53)` → recompute. Derivation (run it, show the numbers in the PR body): `gh issue list --state open --limit 500 --json number,labels | jq length` for the total, then subtract 1 for #211 which this PR closes. Expected result `92 (rfapps 40 · rfmedia 52)`; if `gh` disagrees, trust `gh` (commit `181a49c3 docs(roadmap): sync open issue counts (#272)` exists because this drifted before).
    3. `:33-35` current-focus paragraph: drop #211, keep #213 / #216.
    4. `:47-52` Sprint 1 table: delete the #211 row **and renumber the `Order` column** — #213 becomes 1, #216 becomes 2.
    5. `:190-192` layer diagram `Layer 1 — Local bulk management (#211, #213, #216)` → `(#213, #216)`, and `:196-201` Phase B table: delete the #211 row.
  - `docs/roadmap-archive.md` — the repo splits shipped work between the two files (verified: `9db6c9ef` for #222 and `aee571fc` for #223 both touched ROADMAP.md **and** docs/roadmap-archive.md). Four edits:
    1. `:7` `**Archived:**` → today's date.
    2. `:24` `Lidarr Layer 1 commands` row: append `, [#211](…/issues/211)` to the Issues cell and the closing PR link (with ` (#211)`) to the Closing PRs cell.
    3. `:62` operator note `**Lidarr Layer 1 suite (#198–#200, #222–#223):**` — extend to name #211 and rewrite the trailing sentence "Remaining Layer 1 work is audit (#211), quality presets (#213), and pre-import matching (#216)" to "Remaining Layer 1 work is quality presets (#213) and pre-import matching (#216)". Add one sentence describing the audit: read-only, 7 active checks + 1 reserved `plex-alignment` slot, diagnostic by default with an opt-in `--fail-on` CI gate.
    4. `:80` ordered list entry `5. Lidarr Layer 1 bulk commands — #198, #199, #222, #223, #200` → append `, #211`.
- **Acceptance:** `npm run lint:md` from repo root passes; `git diff --stat` shows all four files.

#### **T17 — Internal plan artifacts**

- **Owns:** `docs/plans/211-lidarr-audit/design.md` (new), `docs/plans/211-lidarr-audit/plan.md` (new)
- **Depends on:** —
- **Scope:** repo convention for sibling features (`docs/plans/223-lidarr-album-suite/{design.md,plan.md}` shipped in `aee571fc`; see also `199-lidarr-artist-bulk-management/`, `159-staged-deployment/`). Copy `/home/yandy/.claude/jobs/74329471/tmp/DESIGN.md` to `design.md` and this final plan to `plan.md`. Prepend to each a one-line front matter sentence naming issue #211. Commit these with `docs(internal): …` so they stay out of release notes.
- **Acceptance:** `npm run lint:md` passes; `npm run format:plans` leaves no diff.

#### **Batch 8 close gate**

```bash
npm run lint:md && npm run format:all && git status --short
```

---

### Batch summary

| Batch | Tasks              | Close gate                                                   |
| ----- | ------------------ | ------------------------------------------------------------ |
| 1     | T1                 | `tsc --noEmit`                                               |
| 2     | T2, T3, T4, T5, T6 | `tsc --noEmit` + `check:architecture`                        |
| 3     | T7                 | `tsc --noEmit` + `check:architecture`                        |
| 4     | T8                 | `tsc --noEmit` + `check:architecture`                        |
| 5     | T9                 | `tsc --noEmit` + `check:architecture`                        |
| 6     | T10, T11           | `tsc --noEmit` + `check:architecture` + `--help` cross-check |
| 7     | T12, T13, T14      | `npm run test:run`                                           |
| 8     | T15, T16, T17      | `lint:md` + `format:all`                                     |

**File ownership is exclusive and disjoint within every batch.** No file appears in two `Owns` lists anywhere in the DAG.

---

## 3. Frozen cross-task contracts (single source of truth)

These three lists are referenced by more than one task. Any change requires editing **every** task listed.

1. **Audit flag set + descriptions** — the table in T10. Consumed by T10 (Commander), T11 (three templates + `lidarrAuditOptions`), T15 (README/feature doc).
2. **Finding codes** — the D17 table. Produced by T5/T7, typed by T1, asserted by T12, documented by T15.
3. **Check ids / fail levels** — `LIDARR_AUDIT_CHECK_IDS`, `LIDARR_AUDIT_FAIL_ON_LEVELS` in T1. Bound to the templates by the D24 assertions in T11.

---

## 4. Exact edit anchors (verified against the current tree)

### `packages/rfmedia-cli/src/actions/lidarr/index.ts` — T9

Current lines 29-30:

```ts
export { executeLidarrHealth, TIER as LIDARR_HEALTH_TIER } from "./health.js";
export type { LidarrHealthActionOptions, LidarrHealthActionResult } from "./health.js";
```

Insert immediately after (blank line, then):

```ts
export { executeLidarrAudit, TIER as LIDARR_AUDIT_TIER } from "./audit.js";
export type { LidarrAuditActionOptions, LidarrAuditActionResult } from "./audit.js";
```

### `packages/rfmedia-cli/src/commands/lidarr.ts` — T10

**Import**, current line 46:

```ts
import { createLidarrSearchCommands } from "./lidarr-search.js";
```

Insert `import { createLidarrAuditCommand } from "./lidarr-audit.js";` immediately after.

**Registration**, current lines 1434-1436:

```ts
lidarrCommand.addCommand(lidarrWantedCommand);
lidarrCommand.addCommand(lidarrHealthCommand);
lidarrCommand.addCommand(lidarrSearchCommand);
```

Insert between `:1435` and `:1436`:

```ts
lidarrCommand.addCommand(
  createLidarrAuditCommand({
    resolveFormat,
    reportLidarrFailure,
    renderExecutionSummary,
    parseIdList,
  }),
);
```

Wiring precedent: `lidarr.ts:437-442`.

### `packages/rfmedia-cli/src/commands/lidarr.test.ts` — T10

Current lines 730-736:

```ts
      expect(lidarrCommand.commands.map((command) => command.name())).toEqual([
        "status",
        "list",
        "albums",
        "wanted",
        "health",
        "search",
```

Insert `        "audit",` after `        "health",` (line 735).

### `packages/rfmedia-cli/src/lib/shell-completions/bash.ts` — T11

**(1)** Line 159: `local lidarr_subcommands="status list albums wanted health search lookup plan apply"` → add `audit` after `health`.

**(2)** Add the three single-line vars in the `:160-181` block (existing bookends: `lidarr_health_opts` at `:165`, `lidarr_health_types` at `:181`).

**(3)** Word scanner — copy the `albums)` dedicated-guard form at `:203-208`:

```
203      albums)
204        # "albums" is a lidarr-only leaf; guard so other families never misroute.
205        if [[ "$cmd" == "lidarr" && -z "$subcmd" ]]; then
206          subcmd="${words[i]}"
207        fi
208        ;;
```

Add an identical `audit)` arm after it. `audit` appears in NO existing arm (the `:192-202` alternation excludes it) and bash `case` is first-match-wins.

**(4)** Dispatch — current `:525-531`:

```
525        elif [[ "$subcmd" == "health" ]]; then
526          if [[ "$prev" == "--type" ]]; then
527            COMPREPLY=($(compgen -W "$lidarr_health_types" -- "$cur"))
528          elif [[ "$cur" == -* ]]; then
529            COMPREPLY=($(compgen -W "$lidarr_health_opts $lidarr_shared_opts $global_opts" -- "$cur"))
530          fi
531		elif [[ "$subcmd" == "search" ]]; then
```

Insert the `audit` branch between `:530` and `:531`.

### `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts` — T11

**(1)** Current `:413-414` inside `lidarr_subcmds` (`:407-418`):

```
413            'health:Show Lidarr system health checks'
414			'search:Search Lidarr for artists and albums'
```

Insert `            'audit:Audit Lidarr library health and drift'` after `:413` (**D10** — do not touch `:404`).

**(2)** Current `:477-484`:

```
477                health)
478                  _arguments \
479                    '*--type[Filter by health check type (repeatable)]:type:(ok notice warning error)' \
480                    '--lidarr-url[Lidarr server URL]:url:' \
481                    '--lidarr-api-key[Lidarr API key]:key:' \
482                    ${globalOpts}
483                  ;;
484				search)
```

Insert the `audit)` case between `:483` and `:484`; block ends with `${globalOpts}`. `-v` uses the house form (precedent `zsh.ts:556`). **D11** applies.

### `packages/rfmedia-cli/src/lib/shell-completions/fish.ts` — T11

**(1)** Predicate — copy the shape at `:1139-1147` (`__fish_rfmedia_lidarr_health_active`).

**(2)** Advertisement — current `:1292`:

```
complete -c rfmedia -n "__fish_rfmedia_lidarr_needs_subcommand" -a "health" -d "Show Lidarr system health checks"
```

Insert the `audit` advert immediately after (order matters for `templates.spec.ts:424-429`).

**(3)** Options block — current `:1345-1348` is `# Lidarr health options`; `:1350` is `# Lidarr search options`. Insert `# Lidarr audit options` between them.

### `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts` — T11

Current `:41-44`:

```ts
const lidarrCommandTree = {
  lidarr: ["status", "list", "albums", "wanted", "health", "search", "lookup", "plan", "apply"],
  lookup: ["artist", "album"],
} as const;
```

→ `"audit"` at index 5. Asserted 3× (`:372`, `:402-404`, `:429`) — must land in the same commit as bash.ts:159 / zsh.ts:413 / fish.ts:1292.

New `lidarrAuditOptions` const after `lidarrSearchOptions` (`:61-67`). Occurrence-count lock to respect, `:494-496`:

```ts
expect(bashScript.match(/\$lidarr_search_opts \$lidarr_shared_opts \$global_opts/gu)).toHaveLength(2);
```

Exact-option lock test to copy verbatim: `:541-567`. Fish value-option map: `:787-901`.

### `packages/rfmedia-cli/README.md` — T15

`## Features` list begins at `:5`. `### Lidarr Albums` at `:4947`; `### Lidarr Mutation Plan/Apply` at `:4975`. New section between them.

### `docs/README.md` — T16

Current `:92-95`:

```
- [Lidarr Execution Lanes](../packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md) -
  Scheduling, retry, cancellation, and execution metadata contracts
- [Lidarr Generated Client](../packages/rfmedia-cli/docs/features/lidarr-generated-client.md) -
  Private SDK ownership, offline regeneration, provenance, and review workflow
```

Add a `- [Lidarr Library Health Audit](../packages/rfmedia-cli/docs/features/lidarr-audit.md) - …` bullet in this list.

### `packages/rfmedia-cli/CHANGELOG.md` — T16

`## [Unreleased]` at `:8`, `### Changed` at `:10`, `### Added` at `:18`. Bullet goes under `### Added`.

### `ROADMAP.md` — T16

`:8` `**Last updated:** 2026-07-25` · `:10` `**Open issues:** 93 (rfapps 40 · rfmedia 53)` · `:33-35` current-focus paragraph naming `#211 / #213 / #216` · `:47-52` Sprint 1 table with an `Order` column (row 1 = #211) · `:190-192` layer diagram `Layer 1 — Local bulk management (#211, #213, #216)` · `:196-201` Phase B table (row 1 = #211).

### `docs/roadmap-archive.md` — T16

`:7` `**Archived:** 2026-07-25` · `:24` `| Lidarr Layer 1 commands | …issues… | …closing PRs… |` · `:62` `- **Lidarr Layer 1 suite (#198–#200, #222–#223):**` (its last sentence names #211 as remaining) · `:80` `5. Lidarr Layer 1 bulk commands — #198, #199, #222, #223, #200`.

---

## 5. Landmines checklist

**Architecture gates (`npm run check:architecture -w packages/rfmedia-cli`):**

1. Never write the literal `fetch(` or `trustedFetch(` in any new **production** `.ts` — including JSDoc and `//` comments. `FETCH_CALL_PATTERN` is declared at `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs:115` and applied to RAW content at `:543` with no comment stripping. Rule name is `plex-fetch-owner` even for Lidarr files. Only a call-paren match trips it (`prefetch(`, `Fetch(`, the bare noun `fetch` are fine) — write "HTTP request" / "round-trip" / "retrieve" anyway. Files with `.test.` or `.spec.` in the name are exempt (`isProductionTypeScriptFile`, `:121-128`) — **`lidarr-audit-fixtures.ts` (T6) is NOT exempt.**
2. Never add or remove a `fetch(`/`trustedFetch(` site in `src/lib/lidarr/transport.ts` (currently exactly one, at `:319`) — `lidarr-fetch-owner-count` fires.
3. Never import `src/lib/plex`, `src/lib/plex-cache`, `src/lib/plex-filter-evaluator`, or `src/lib/plex-pagination` (`legacy-plex-module`, four modules — **D14**). Never import `src/lib/adapters/plex/*` (`private-plex-import`). Never import `src/types/plex` (`plex-compatibility-import`; the 11-entry allowlist contains none of your files). Plex speaks only `src/lib/adapters/action-helpers.js` + `src/types/media-server.js`.
4. Never put a string literal containing `/api/v1/` in any file (`handwritten-lidarr-api-path`; comments are exempt, string/template literals are not).
5. Never place the key `artistIds` in the same object literal as any of `{addImportListExclusion, applyTags, deleteFiles, metadataProfileId, moveFiles, qualityProfileId, rootFolderPath, tags}` (`lidarr-editor-body-owner`, purely structural). Finding subjects use SINGULAR `artistId` by design. `interface LidarrAuditActionOptions` is safe — the rule only inspects object literals.
6. Never statically import `./index.js` from `src/lib/lidarr/audit*.ts` (ESM cycle; the barrel does `export * from "./health.js"`). Import `LidarrClientOverrides` from `./health.js`. `src/lib/lidarr/album-selection.ts` is NOT in the barrel, so importing it directly is cycle-free.
7. Never register the audit modules in `src/lib/lidarr/index.ts` (DESIGN §8 non-goal 7).

**TypeScript config:**

8. `noUncheckedIndexedAccess` is ON — every `map.get(x)` / `arr[i]` is `T | undefined`. Guard every one; a single miss is a runtime `TypeError` the engine converts into `check-error`, silently degrading the report.
9. `noPropertyAccessFromIndexSignature` is ON — every Commander option read is `cmdOptions["failOn"]`, never `cmdOptions.failOn`.
10. `verbatimModuleSyntax` is ON — `import type` for every type-only import; `.js` extensions on all relative imports.

**Existing-test pins:**

11. `templates.spec.ts:494-496` pins `$lidarr_search_opts $lidarr_shared_opts $global_opts` at exactly 2 occurrences — never reuse `$lidarr_search_opts` for audit.
12. `templates.spec.ts:213-217` (`extractBashCandidates`) splits on `" "` — keep every `lidarr_audit_*` var on ONE line.
13. `templates.spec.ts:230` (`extractZshCaseOptions`) detects `-v` only via the literal `{-v,--verbose}`, and harvests every `/--[a-z][a-z-]*/` token in the block — including tokens inside descriptions.
14. `templates.spec.ts:245-254` (`extractFishOptions`) detects `-v` only via ` -s v` (**D23**).
15. `templates.spec.ts:234-243` (`extractZshCaseBlock`) resolves markers by raw `indexOf` — the zsh `audit)` block must contain no `status)`, `list)`, `albums)`, `wanted)`, `health)`, `search)`, `lookup)`, `plan)`, `apply)`, `artist|album)`, or plan-operation `<word>)` literal (breaks `:470`, `:471`, `:499`, `:585`, `:600`).
16. `templates.spec.ts:372`, `:402-404`, `:429` all assert `toEqual(lidarrCommandTree.lidarr)` order-sensitively — bash.ts:159, zsh.ts:413, fish.ts:1292 and templates.spec.ts:42 MUST land together (all inside T11).
17. `templates.spec.ts:903-910` bans `--lane-concurrency`, `--operation-budget`, `--retry-backoff-cap` from generated scripts.
18. `lidarr.test.ts:730-740` fails until `"audit"` is inserted at index 5 (T10).
19. `lidarr.test.ts:1948-1966` is the report-not-gate contract to mirror (NOT `:1947`, which is blank).
20. `templates.spec.ts` asserts that generating completions performs no network call and constructs no adapter — importing `src/types/lidarr-audit.js` there is safe **only** because T1 has zero value imports.

**Commander:**

21. Never throw `InvalidArgumentError` from the `--check` argParser — it calls `Command.error()` → `process.exit(1)`, killing the vitest worker and the whole test file (**D1**). The same hazard applies to `.choices()` on `--fail-on`: never pass an invalid value in a test without `armCommanderThrow` (`lidarr.test.ts:1974`).
22. `.helpGroup()` only exists on `Option` — always `.addOption(new Option(...).helpGroup(...))` (**D9**). Do not use `Command.optionsGroup()` (zero precedent).

**Test lifecycle:**

23. `vi.hoisted()` before `vi.mock()` factories; SUT imported AFTER all mocks; `vi.clearAllMocks()` in `beforeEach`. **`vi.resetAllMocks()` is banned** — it nulls hoisted implementations.
24. The barrel mock for `../../lib/lidarr/index.js` must export `resolveRequiredLidarrOrigin` in addition to `resolveLidarrScheduler` / `resolveRequiredLidarrClient`.
25. `src/commands/lidarr-audit.test.ts` must mock all five modules from `lidarr.test.ts:644-648` before importing `lidarrCommand`.

**Environment:**

26. `FORCE_COLOR` is exported in the agent shell; it breaks two rf-common logger tests and blocks `git push` via the pre-push hook. Prefix EVERY vitest invocation with `env -u FORCE_COLOR`.
27. `rfmedia` is only on PATH after `npm run link`. From the repo root use `npm run rfmedia -- lidarr audit --help` (`package.json:10`).

---

## 6. Verification gauntlet (run in this order, at the end)

```bash
# 1. Targeted suites (fast feedback) — from the package
cd packages/rfmedia-cli
env -u FORCE_COLOR npx vitest run \
  src/lib/lidarr/audit.test.ts \
  src/actions/lidarr/audit.test.ts \
  src/commands/lidarr-audit.test.ts \
  src/commands/lidarr.test.ts \
  src/lib/shell-completions/templates.spec.ts

# 2. Architecture gates on their own (clearest error output) — from repo root
npm run check:architecture -w packages/rfmedia-cli
npm run test:architecture -w packages/rfmedia-cli

# 3. Typecheck — `pretypecheck` chains codegen:lidarr:check + check:architecture
#    + test:architecture, so read the TOP of the output first
npm run typecheck --workspace packages/rfmedia-cli

# 4. Full workspace test run
env -u FORCE_COLOR npm run test:run

# 5. Help-surface cross-check (D9 + frozen flag set)
npm run rfmedia -- lidarr audit --help

# 6. Docs + formatting (repo root only — there is no per-package lint/format script)
npm run lint:md
npm run format:all

# 7. Re-run 3 + 4 if step 6 reformatted anything
```

Expected step-2 output: `OK: Plex/Lidarr dependency direction and authenticated fetch ownership across NNN production files.` (exit 0).

---

## 7. Definition of done

**Production code (9 new files, 4 modified):**

- [ ] `src/types/lidarr-audit.ts` — registry frozen as `Object.freeze({…} as const) satisfies Readonly<Record<…>>` (D6); `circuits` reuses `LidarrResilienceSnapshot["circuits"]` (D7); `LIDARR_AUDIT_FINDING_CODES` + `findingCodes` per descriptor (D17); `shouldFailLidarrAudit` (D2); `createLidarrAuditFinding` (D22); `LIDARR_AUDIT_UNREACHABLE_DETAIL` (D20); zero value imports.
- [ ] `src/lib/lidarr/audit-identity.ts` — NFKD + combining-mark strip + article strip over `normalizeForMatch`; case-sensitive path normalization; `groupDuplicates` excludes `undefined`/`""` keys.
- [ ] `src/lib/lidarr/audit-queue.ts` — outer AND inner try/catch (D3); two-DB-opens documented (D4); `LidarrClientOverrides` from `./health.js` (D16); structurally cannot throw.
- [ ] `src/lib/lidarr/audit-platform-checks.ts` — 4 pure evaluators; exhaustive `LidarrHealthType` switch with `const exhaustive: never`; blank path counts as unrooted (D5); all findings via `createLidarrAuditFinding` with D17 codes.
- [ ] `src/lib/lidarr/audit-library-checks.ts` — 3 pure evaluators; reuses `filterLidarrAlbums`; absent `releaseDate` stays a gap (D13); one finding per duplicate group with `affected` = member count (D22).
- [ ] `src/lib/lidarr/audit.ts` — `EVALUATORS` keyed on `LidarrAuditEvaluatedCheckId`; requirement gating + per-check error isolation; `coverage` per D21; `resolveLidarrAuditSelection` throws `LookupNotFoundError` (D1); no `./index.js` import.
- [ ] `src/actions/lidarr/audit.ts` — one `runSingle`, client resolved inside the callback (D15), scan/queue/Plex outside it; `health` slot stays available on unreachable (D20); duplicate `listArtists` in deep mode documented (D25); fail-closed deep scan naming both escape hatches.
- [ ] `src/actions/lidarr/audit-plex.ts` — adapter construction inside the try, non-`MediaServerError` mapped to `configuration` (D8).
- [ ] `src/commands/lidarr-audit.ts` — DI factory; `parseAuditCheckIds` accumulates and never throws (D1/D19); exactly two pre-flight checks (D18); every grouped flag via `.addOption(new Option(...).helpGroup(...))` (D9); `plexToken` in `sensitiveValues`; gate applied after rendering; no `console.log`.
- [ ] `src/actions/test-helpers/lidarr-audit-fixtures.ts` — health-report / queue-state / Plex-probe / gathered-data / slot builders; architecture-clean.
- [ ] `src/actions/lidarr/index.ts`, `src/commands/lidarr.ts` — registered at index 5 between `health` and `search`.
- [ ] `LidarrSuccessCommand` / `LidarrSuccessActionResult` / `projectLidarrCsvSuccess` untouched.

**Tests (exactly 3 new test files — no others):**

- [ ] `src/lib/lidarr/audit.test.ts` — every DESIGN §7 file-1 bullet plus the `plex-alignment` #208 regression guard, the D17 code-contract sweep, the D21 coverage matrix, the D18 `degraded` + `--fail-on critical` case, and the non-mutating-remediation regex sweep.
- [ ] `src/actions/lidarr/audit.test.ts` — every §7 file-2 bullet plus the zero-request `--check retry-backlog` assertion, the D20 unreachable-slot matrix, and the Plex-token leak guard.
- [ ] `src/commands/lidarr-audit.test.ts` — full exit-code matrix, stdout purity, CSV column/row order, both pre-flight failure envelopes, and the D19 `--check` accumulation case.
- [ ] `src/commands/lidarr.test.ts:735` — `"audit"` inserted.
- [ ] No `audit-identity.test.ts`, `audit-queue.test.ts`, `audit-plex.test.ts`, or renderer snapshot test was created.

**Shell completions (one commit, T11):**

- [ ] `bash.ts` — 4 edits, single-line vars, dedicated guarded word-scanner arm, no `$lidarr_search_opts` reuse.
- [ ] `zsh.ts` — 2 edits, inserted after `:413`, `{-v,--verbose}` house form, `'*--check…'` repeatable, no `<word>)` literal.
- [ ] `fish.ts` — 3 edits, `-r` on every value flag, `-xa` on `--check`/`--fail-on`, `-s v -l verbose`, descriptions byte-identical to zsh.
- [ ] `templates.spec.ts` — command tree at index 5, `lidarrAuditOptions` exact-option lock (negative `--allow-stale`, positive `-v`), D24 registry-binding assertions for check ids and fail levels in all three shells, Fish value-option map entry.

**Docs:**

- [ ] `packages/rfmedia-cli/docs/features/lidarr-audit.md` — new feature doc incl. the D17 code catalog, the D18 `--fail-on`/`degraded` note, the D25 deep-mode cost, and the rejected-checks section for #208's implementer.
- [ ] `packages/rfmedia-cli/README.md` — `### Lidarr Library Health Audit` between `:4947` and `:4975` + one `## Features` bullet + the `See […](docs/features/lidarr-audit.md)` pointer.
- [ ] `docs/README.md` — one bullet in the Lidarr feature-doc list.
- [ ] `packages/rfmedia-cli/CHANGELOG.md` — bullet under the existing `### Added` (`:18`).
- [ ] `ROADMAP.md` — current focus, Sprint 1 table **with the `Order` column renumbered**, layer diagram + Phase B table, `**Open issues:**` recomputed via `gh`, `**Last updated:**`.
- [ ] `docs/roadmap-archive.md` — `**Archived:**` date, `:24` table row, `:62` operator note, `:80` ordered-list entry.
- [ ] `docs/plans/211-lidarr-audit/{design.md,plan.md}` — committed with `docs(internal): …`.
- [ ] NEITHER `docs/features/shell-completion.md` (rfapps CLI) NOR `packages/rfmedia-cli/docs/features/shell-completion.doc.md` (rfmedia; verified to contain zero `lidarr` references) was touched — DESIGN §8 non-goal 11.

**Gates:**

- [ ] Section 6 gauntlet fully green, including `npm run check:architecture -w packages/rfmedia-cli` exit 0, `npm run test:architecture -w packages/rfmedia-cli` exit 0, `env -u FORCE_COLOR npm run test:run` green, and `npm run lint:md`.
