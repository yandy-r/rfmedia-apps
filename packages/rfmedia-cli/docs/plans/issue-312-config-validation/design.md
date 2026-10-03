# Issue #312 — Extract config validation primitives

Design of record. Synthesised from four independent proposals and twelve judge reviews. Every
load-bearing fact below was re-verified against the working tree at `config.ts` = 5291 lines
(matches `HEAD`, tree clean at time of writing).

All paths are absolute-rooted at:

```text
/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-312-config-validation
```

Unqualified `L<n>` means `packages/rfmedia-cli/src/lib/config.ts`.

## 1. Problem and constraints

`config.ts` is 5291 lines. #209 added inline policy validation and explicitly deferred extracting
the shared validation primitives, because moving them touches ~111 call sites plus a 3717-line
co-located test. This chore has **zero user-facing benefit** and must not ride a feature PR.

Hard constraints:

- No user-facing CLI behaviour change.
- `ConfigError` must have a single canonical export.
- Existing config validation tests pass with no intentional message or `propertyPath` regressions.
- Repo conventions: ESM NodeNext with mandatory `.js` import extensions, no `any`, throw early,
  Vitest, `commands/actions/lib/types` separation.

Three risks are named in the issue and each is addressed explicitly below:

- **(a)** silent behaviour change in path-aware `ConfigError` messages, or in the `loadConfig`
  catch fall-through — see sections 4 and 6.
- **(b)** import cycle between config load and validation helpers — see section 5.
- **(c)** large mechanical test churn if assertion text or paths drift — see sections 6 and 7.

Verified facts that shape the design:

- Exactly one `class ConfigError` exists repo-wide (L124).
- `error-formatters.ts:12` is the only production importer; it uses a bare `instanceof` at
  `error-formatters.ts:221`.
- `http-url.ts` is 47 lines with **zero** import statements — a true leaf.
- **Zero** test files import or spy on any primitive; all coverage flows through `validateConfig`,
  `loadConfig`, `mergeConfigs`, `getInteractiveConfig`.
- `packages/rfmedia-cli/tsconfig.json` sets `verbatimModuleSyntax: true`, `isolatedModules: true`,
  `moduleResolution: NodeNext`, and does **not** set `noUnusedLocals`.
- Baseline measured on this branch: 286 tests pass across the four config-adjacent files.

## 2. Decision (module layout)

**ONE new flat file. No directory, no barrel, no second error module.**

| Path                                                | Lines               | Responsibility                                                                                                                                            |
| --------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/src/lib/config-validation.ts` | ~205 new            | Declares `ConfigError` and the domain-generic config assertion primitives. Imports exactly one module: `./http-url.js`.                                   |
| `packages/rfmedia-cli/src/lib/config.ts`            | 5291 → ~5090        | Unchanged responsibilities: search paths, load/merge/template IO lifecycle, accessors, every `validateXxxConfig` section validator, and `validateConfig`. |
| `packages/rfmedia-cli/src/lib/error-formatters.ts`  | 371, 1 line changed | Import specifier only.                                                                                                                                    |

### 2.1 Why one module and not two

Three of the four proposals wanted a separate `config-error.ts`. **Rejected**, decisively:

1. The stated benefit — "`error-formatters.ts` reaches the error type without loading validation
   machinery" — is **self-defeating under a barrel** and near-zero without one. The clean-arch
   variant routed `error-formatters.ts` through `config-validation/index.js`, whose
   `export … from "./primitives.js"` is eagerly evaluated, so all three files load anyway.
2. Measured cost of the "machinery" being avoided: ~205 lines of pure functions plus a 47-line
   zero-import leaf. The real win is escaping the **5291-line** `config.ts`, and that is delivered
   by repointing the import regardless of file count.
3. The issue says "a dedicated module" (singular). No repo precedent exists for a ~25-line
   single-class flat module; the smallest dedicated error module is `secure-store/errors.ts` at
   203 lines, inside a subdirectory.
4. With one module the `describeType` placement question dissolves. `describeType` is an
   error-_message_ helper, not a validator; splitting error from primitives forces an arbitrary
   choice about where it lives.

Accepted cost: if `config-validation.ts` is later split, `ConfigError` moves a second time. That is
a three-line change, cheaper than shipping an extra file now.

### 2.2 Why flat and not `src/lib/config/`

`packages/rfmedia-cli/CLAUDE.md:994-998` documents the default as `src/lib/newutil.ts`. The closest
functional precedent is `src/lib/lidarr/plan-validation.ts` — 94 lines, "Shared strict validation
primitives", no barrel, no co-located test. `loaded-config.ts` is the house precedent for a flat
config-adjacent sibling. `secure-store/` is a ~1400-line four-module subsystem; this is ~205 lines.

### 2.3 The admission rule (goes in the module header)

This is the durable deliverable. A helper belongs in `config-validation.ts` **iff all four hold**:

1. Its signature is `(value: unknown, …, propertyPath: string, configPath: string)` and it throws
   `new ConfigError(message, configPath, propertyPath)`.
2. Its **message text** names no feature domain — no "convert format", "range", "page size",
   "preset", "disk space".
3. Its imports are confined to `./http-url.js`; it pulls in no `../types/*` feature type.
4. It has **≥2 call sites spanning ≥2 distinct top-level config sections**.

The rule has **no exceptions and no sibling escape hatch**. Two judges independently flagged the
"or is the direct sibling of one that does" clause proposed elsewhere as unfalsifiable; it existed
solely to admit `validateRatingPercent`, which nothing depends on moving. Dropping that clause and
leaving `validateRatingPercent` in place makes the rule mechanically applicable by the next author.

One honesty note belongs in the header: `validateStarRating` has a domain-flavoured **name** but a
domain-free **contract** and message (`Expected number between 1.0 and 5.0 for …`). It is admitted
under clause 4 as a shared cross-section value domain (copy + plex + policy), not because it is
"generic".

## 3. What moves / what stays

### 3.1 Moves to `config-validation.ts`

Move each declaration **together with its preceding JSDoc block**, by cut-and-paste, never retyped.

| Symbol                       | Line                 | Call sites                   | Note                                                              |
| ---------------------------- | -------------------- | ---------------------------- | ----------------------------------------------------------------- |
| `ConfigError`                | L124 (block 121-136) | 133 `new` + 2 `instanceof`   | Already `export`; sole declaration                                |
| `describeType`               | L142 (block 138-146) | 48                           | Add `export`; message helper, zero deps                           |
| `rejectUnknownConfigKeys`    | L212                 | 9                            | Add `export`                                                      |
| `validateBoolean`            | L278                 | 32                           | Add `export`                                                      |
| `validatePositiveInteger`    | L317                 | 18                           | Add `export`                                                      |
| `validateNonNegativeInteger` | L331                 | 6                            | Add `export`                                                      |
| `validateBoundedInteger`     | L349                 | 14                           | Add `export`                                                      |
| `validateString`             | L369                 | 20                           | Add `export`                                                      |
| `validateStringArray`        | L384                 | 5                            | Add `export`                                                      |
| `validateStarRating`         | L424                 | 5 across copy/plex/policy    | Move the `Number.isFinite` / YAML `.nan` rationale JSDoc verbatim |
| `validateUrl`                | L898                 | 2 (plex.url, lidarr.baseUrl) | Carries the sole `./http-url.js` edge                             |
| `requireConfigObject`        | NEW                  | replaces 6                   | Consolidation — see 3.2                                           |

Also **deleted** from `config.ts`: `import { normalizeHttpUrl } from "./http-url.js";` at **L75**.
Verified: `normalizeHttpUrl` occurs at exactly two lines in `config.ts` (L75 import, L907 inside
`validateUrl`). Once `validateUrl` moves, L75 is dead — and **no gate catches it**:
`noUnusedLocals` is absent from the tsconfig, the repo has no ESLint (`lint` is typecheck +
markdownlint), Prettier does not prune imports, and lefthook runs only Prettier, tests, commitlint.

### 3.2 The one consolidation: `requireConfigObject`

`requireLidarrCascadeAnalysisObject` (L1691) and `requirePolicyConfigObject` (L2836) are
**verified byte-identical apart from the function name** — I diffed them with the names normalised
and the result was empty. Same guard, same
`` `Expected object for ${propertyPath}, got ${describeType(value)}` `` literal, same
`(configPath, propertyPath)` argument order.

This is a live DRY violation introduced by #209 — the same PR that deferred this extraction — and
the new module is its only correct home. Left alone, the next feature validator adds a third copy
into the file this issue exists to stop growing.

It is a **merge, not a move**, so it is sequenced **last and is independently revertable**. If a
reviewer wants a pure move, drop step 8 and nothing else changes.

Explicitly **not** in scope: the ~20 open-coded inline `Expected object for …` throws (L1698,
L2691, L2707, L2797, L3291, L3442, L3524, L4198, …). Converting those is 20 hand edits, each an
independent chance to transpose `configPath`/`propertyPath`.

### 3.3 Stays in `config.ts`

| Symbol                                                                                                       | Line               | Rule clause failed / reason                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validateRatingPercent`                                                                                      | L438               | **Clause 4** — 1 call site (`copy.minRating` L710), 1 section                                                                                                                    |
| `validatePageSize`                                                                                           | L298               | **Clause 4** — 3 call sites, all inside `validateInteractiveConfig` (L3236/3244/3252); also closes over `MIN_PAGE_SIZE`/`MAX_PAGE_SIZE` (L117-118) interpolated into its message |
| `validateConvertFormat`                                                                                      | L399               | **Clauses 2, 3, 4** — see 3.4                                                                                                                                                    |
| `validateRangeString`                                                                                        | L452               | **Clauses 2, 4** — 1 call site; encodes copy's `"001-010"` track-range convention                                                                                                |
| `validateDiskSpaceMargin`                                                                                    | L619               | **Clauses 2, 4** — 1 call site; see 3.5                                                                                                                                          |
| `SENSITIVE_FIELD_NAMES` / `isSensitiveFieldName` / `redactSensitiveFields`                                   | L156 / L172 / L187 | **Clause 1** — logging redaction, never construct a `ConfigError`, take no `propertyPath`/`configPath`; only consumers are `deepMergeObjects` debug logs at L5000-5005           |
| 8 Lidarr preset helpers                                                                                      | L1801-1958         | **Clause 1** — see 3.6                                                                                                                                                           |
| `MIN_PAGE_SIZE`, `MAX_PAGE_SIZE`, `MAX_SEPARATION_GAP`, `VALID_CONVERT_FORMATS`, `VALID_CONFLICT_STRATEGIES` | L117-119, L99-100  | Each stays with the only validator that interpolates it. Splitting a constant from its message template is the concrete path to risk (c)                                         |
| `_copyValidatorCoversConfigOptions`, `_plexValidatorCoversConfigOptions`                                     | L804, L1499        | Compile-time exhaustiveness sentinels bound to `CopyConfigOptions`/`PlexConfigOptions` key unions                                                                                |
| Every `validateXxxConfig`, `validateConfig`, `loadConfig`, template/merge/accessor block                     | L633-5291          | Out of scope; subject of follow-ups                                                                                                                                              |

### 3.4 Refutation: the "enum helpers" clause

The issue's scope line names "the integer/string/boolean/**enum** helpers", and this design moves
**zero** enum helpers. That is a deliberate, argued deviation, not an oversight — recorded here
because three reviewers flagged it.

First, a wrong reason must be discarded. The claim that moving `validateConvertFormat` would trip
`check:architecture` is **false**: the `plex-compatibility-import` rule fires on imports of
`src/types/plex`, and `src/types/index.ts` is itself on `PLEX_COMPATIBILITY_ALLOWLIST`
(`scripts/check-direct-plex-imports.mjs:150`). A `ConvertFormat` type import is erased entirely
under `verbatimModuleSyntax`. The gate is not the obstacle.

The real obstacle is message prose. The four enum validators each carry a **distinct singular noun
and a distinct plural label**, verified verbatim:

```text
L399 validateConvertFormat  : Invalid convert format for X: v. Valid formats: …
L510 validateFilterField    : Invalid filter field for X: v. Valid fields: …
L528 validateFilterOperator : Invalid filter operator for X: v. Valid operators: …
L546 validateMatchType      : Invalid match type for X: v. Valid types: …
```

A single generic `validateEnum` reproducing these byte-for-byte would need to accept **both** an
English singular noun and an English plural label as parameters — parameterising prose, not logic.
That is a worse abstraction than four explicit functions, and any deviation breaks assertions such
as `config.test.ts:2254` (`"Valid modes: static, jwt"`). Each validator also fails clause 4
independently: `validateConvertFormat` has exactly one call site (L666).

Verdict: the enum helpers stay. The issue's completion check that governs is "primitives live
outside config.ts", which is satisfied; the enumeration in the scope line was a candidate list, not
a contract.

### 3.5 Why `validateDiskSpaceMargin` must not move

Its guard is `typeof value !== "number" || value < 0 || value > 50` — **no `Number.isInteger`, no
`Number.isFinite`**. `NaN` passes all three comparisons, so `copy.diskSpaceMargin: .nan` is
**currently accepted**. Placing it beside `validateStarRating`, which carries an explicit
`Number.isFinite` rationale comment, invites a "harmonisation" that is a real user-visible
behaviour change — forbidden in a no-behaviour-change chore. File the NaN gap as a separate bug.

### 3.6 Why the Lidarr preset helpers must not move

They fail clause 1 twice over. Their argument order is **inverted** relative to the generic family:
`failLidarrPreset(message, propertyPath, configPath)` at L1801 performs the swap into
`new ConfigError(message, configPath, propertyPath)` at L1802. They also thread a mutable
`LidarrPresetValidationContext` (L1795) DoS-budget accumulator and close over ten preset constants
(L1759-1792). Unifying their signatures is a silent-transposition hazard on **exactly** the
`configPath`/`propertyPath` pair the issue names as risk (a) — and it is invisible to the type
checker, since both parameters are `string`.

## 4. ConfigError canonical export

**Decision: one declaration in `config-validation.ts`; both consumers repointed; NO back-compat
re-export in `config.ts`.**

Concrete edits:

- `config-validation.ts` declares `export class ConfigError extends Error` — moved verbatim from
  L121-136, keyword unchanged.
- `config.ts` gains a **value** import (no `type` modifier) of `ConfigError` plus the eleven
  helpers. It needs the runtime binding for 133 `new ConfigError(…)` sites and the `instanceof` at
  L4721.
- `error-formatters.ts:12` changes from `"./config.js"` to `"./config-validation.js"`.
- `config.test.ts:60-66` splits: four names stay on `"./config.js"`, `ConfigError` moves to
  `"./config-validation.js"`.

### 4.1 Why no re-export, decided against the cheaper option

A `export { ConfigError } from "./config-validation.js";` line in `config.ts` would cut test churn
from 2 lines to 0 and is identity-safe. **Rejected on measured in-repo evidence, not taste:**

`config.ts:27` already does exactly this for `clearConfigCache`, and it has **zero importers**.
Verified — both real consumers go straight to the source:

```text
config.ts:27               export { clearConfigCache } from "./loaded-config.js";   <- 0 users
config.test.ts:68          import { clearConfigCache } from "./loaded-config.js";
actions/filter.ts:13       import { …, clearConfigCache } from "../lib/loaded-config.js";
```

The repo ran this experiment and the shim rotted. Adding a second one is the "temporary
compatibility shim during refactoring" the repo's own policy forbids, and it costs two touched
lines to avoid. Two lines is not the "large mechanical test churn" risk (c) contemplates.

Repointing also **structurally kills a live hazard**. Six action tests replace `../lib/config.js`
wholesale with partial `vi.mock` factories that export no `ConfigError`
(`verify-filter.test.ts`, `plex-copy.test.ts`, `plex-query.test.ts`, `copy-album.test.ts`,
`verify-album.test.ts`, `plex-playlist.test.ts`). Under a re-export, any future test that both
mocks `config.js` and loads `error-formatters.ts` gets `ConfigError === undefined` and
`instanceof` throws `TypeError: Right-hand side of 'instanceof' is not callable`. No mock targets
`./config-validation.js`, so that failure class becomes impossible.

Bonus graph effect: `error-formatters.ts` is registered on every CLI invocation from `cli.ts:37`.
Repointing removes the **only** in-edge to `config.ts` from anywhere under `src/lib/`.

### 4.2 Why `instanceof` stays correct

Both runtime `instanceof` sites bind to the same constructor object because there is exactly **one**
declaration and resolution is unaliased:

- `config.ts:4721` — inside `loadConfig`'s catch, after the `SecretsInjectionError` re-throw at
  L4718.
- `error-formatters.ts:221` — `canHandle: (error): error is ConfigError => error instanceof ConfigError`.

NodeNext relative resolution with no `paths` aliasing and no `src/lib/index.ts` barrel guarantees a
single module instance, hence a single class object. All 87 identity assertions in `config.test.ts`
(34 `toBeInstanceOf` + ~53 `toThrow(ConfigError)`) continue to hold.

### 4.3 Prohibited forms

Under `verbatimModuleSyntax: true` + `isolatedModules: true`:

- **Never** `export type { ConfigError }` — erased from emitted JS; `config.ts:4721` becomes a
  runtime `ReferenceError`. TypeScript does **not** flag this form.
- **Never** `import type { ConfigError }` or inline `{ type ConfigError }` in `error-formatters.ts`
  **or in `config.test.ts`**. The test uses `ConfigError` as both a value (`toBeInstanceOf`,
  `toThrow`) and a type (`(error as ConfigError).propertyPath`), which makes a "tidy-up" to
  `import type` tempting and fatal.

Guard: `grep -rn "class ConfigError" --include="*.ts" packages/` must return exactly one line.

## 5. Import graph and cycle proof

Concrete edges after the change:

```text
config-validation.ts  ->  ./http-url.js                     (sole import)
config.ts             ->  ./config-validation.js            (ADDED, value import)
config.ts             ->  ./http-url.js                     (DELETED, was L75)
error-formatters.ts   ->  ./config-validation.js            (REPLACES -> ./config.js)
```

The transitive closure reachable from `config-validation.ts` is exactly `{ http-url.ts }`.
`packages/rfmedia-cli/src/lib/http-url.ts` has **zero** import statements (verified: `grep -c
"^import"` returns 0; the file opens with an `interface`). It is terminal.

That closure contains neither `config.ts`, `loaded-config.ts`, `error-formatters.ts`, `logger.ts`,
`filesystem.ts`, nor `db.ts`. **A cycle is not merely absent — it is unconstructible.** Issue risk
(b) is retired structurally.

None of the moved primitives log; every one only throws and returns, so `./logger.js` is not
needed. Even adding it later would stay acyclic (`logger.ts` imports only `@rfmedia/common`, and
`rf-common` has no dependency back into rfmedia-cli).

Note: after repointing, `error-formatters-registration.test.ts` no longer loads `config.ts`, so it
ceases to be a `config.ts` module-init canary. Post-change that role belongs to `config.test.ts`.

### 5.1 Architecture gate

`scripts/check-direct-plex-imports.mjs` runs under **both** `pretypecheck` and `prebuild`, so a
violation breaks typecheck and build, not just a lint step. It scans every non-`.test.`/`.spec.`
`.ts` under `src/`, so the new module is picked up automatically.

- The new module imports no `src/types/plex*`, so `plex-compatibility-import` cannot fire.
- **Do not** add `config-validation.ts` to `PLEX_COMPATIBILITY_ALLOWLIST`. The list's own header
  forbids widening it for helpers, and `config.ts`'s existing entry is already vestigial.
- **Prose traps.** `FETCH_CALL_PATTERN = /\b(?:fetch|trustedFetch)\s*\(/g` at script L163 is
  applied to **raw file text including comments**, and the `handwritten-lidarr-api-path` rule
  matches `/api/v1/` in any string literal. The new module's JSDoc — especially `validateUrl`'s —
  must contain neither substring.

## 6. Behaviour-preservation contract

These observable properties must not drift.

1. **`ConfigError` class identity.** Exactly one declaration. 87 identity assertions plus both
   `instanceof` sites depend on it.
2. **`.propertyPath` exact strings.** 30 exact assertions plus parameterised `it.each` paths.
3. **`.message` text.** Substring-stable at 36 sites; **byte-exact** at `config.test.ts:526-528`.
   ~15 further `toThrow("<full sentence>")` sites, e.g. `config.test.ts:133-142` (`Invalid URL
format for plex.url: … Must be http:// or https://`) and `:357-359` (lidarr.baseUrl).
4. **`.configPath`.** Asserted by **no** test. Its only consumer is `error-formatters.ts:227`.
   This is the single moved field with zero existing coverage — see section 7.
5. **`loadConfig` fall-through.** A validation failure must still `logWarn("Config validation error
in …")` and `continue` to the next search path, rather than escaping or falling into the generic
   `Error reading config file …` branch at L4724. Exercised by `config.test.ts:3543-3574`.
6. **Path-quoting convention.** `config.ts` uses **unquoted** paths (`for lidarr.timeoutMs`);
   `paths-yaml.ts` uses **quoted** (`for 'destination'`). Do **not** unify them.
7. **`got` suffix asymmetry.** `validateStarRating` ends with `got ${value}`, while the
   `describeType` family ends with `got ${describeType(value)}`. This is precisely what a
   copy-paste-then-tidy pass "fixes", turning `got NaN` into `got number`. Preserve it verbatim.
8. **Argument transposition.** Every helper takes `(value, …, propertyPath, configPath)` and calls
   `new ConfigError(message, configPath, propertyPath)`. Both are `string`, so a swap is invisible
   to the type checker.

### 6.1 How we prove it

Three mechanical gates, in increasing strength. Eyeballing 200 moved lines is not a proof.

**Gate A — single class identity.**

```bash
grep -rn "class ConfigError" --include="*.ts" packages/
# must return exactly one line, in config-validation.ts
```

**Gate B — exact range equality (not set-membership).** A `comm` set-difference over template
literals only proves no _new_ literal appeared; it cannot detect a moved literal mutated into some
other literal already present elsewhere. Diff the actual ranges instead:

```bash
git show HEAD:packages/rfmedia-cli/src/lib/config.ts > /tmp/head-config.ts
# for each moved block, compare the extracted body against the HEAD range,
# normalising only the added `export ` keyword and Prettier re-wrapping:
diff <(sed -n '121,146p' /tmp/head-config.ts) \
     <(sed -n '<new-range>p' packages/rfmedia-cli/src/lib/config-validation.ts)
```

**Gate C — mutation check.** A green suite does not prove the tests still _reach_ the relocated
code. For four representative templates — `Expected boolean for`, `Expected non-negative integer
for`, `Expected integer between ${minimum} and ${maximum} for`, `Expected object for` — change one
character in `config-validation.ts`, confirm the specific assertion fails
(`config.test.ts:1673`, `:1394-1396`, `:2326-2328`, `:749-751`), then revert.

## 7. Test strategy

**Total churn: 2 edited lines, 1 added test (~14 lines). Zero test rewrites.**

### 7.1 Edits (2 lines)

- `config.test.ts:60-66` — split the import so `ConfigError` resolves from
  `"./config-validation.js"`; the other four names stay on `"./config.js"`. Must be a **value**
  import (see 4.3).
- `error-formatters.ts:12` — specifier only.

Everything else is untouched. Verified: a grep for all 18 primitive names across every
`*.test.ts` / `*.spec.ts` under `packages/` returns **zero hits** — no test imports or spies on any
primitive. `config.test.ts`'s own docblock records that validation functions are internal and are
tested through `validateConfig`. `config-init-merge.test.ts`, `cli.test.ts` (which uses
`importOriginal()` spread), and the six partial-factory mocks need no edits.

### 7.2 The one required addition, justified

A `ConfigError` case in `packages/rfmedia-cli/src/lib/error-formatters.test.ts`:

```text
formatError(new ConfigError(
  "Expected boolean for plex.cache.enabled",
  "/test/config.yaml",
  "plex.cache.enabled",
))
=> message:    Invalid configuration at 'plex.cache.enabled': Expected boolean for plex.cache.enabled
=> suggestion: contains /test/config.yaml
```

This is structural, not stylistic. Three independent facts justify it:

1. `error-formatters.ts:219-235` is the **only** production consumer of `ConfigError` outside
   `config.ts`, and its `canHandle` is a bare `instanceof`.
2. That branch has **zero coverage today** — verified: `grep -c "ConfigError"
error-formatters.test.ts` returns **0**. All 12 existing tests target other error types.
3. It is the one failure mode `config.test.ts` **structurally cannot** catch, because that file
   imports `ConfigError` from the same specifier the validators throw from — a dual-identity split
   would still look self-consistent to all 87 of its assertions. This test imports from the other
   side of the seam.

It also provides the only automated coverage of `.configPath`, the single moved field no existing
test asserts (section 6, property 4).

### 7.3 Deliberately NOT tested

- **No `config-validation.test.ts` unit layer for the moved primitives.** The 263 existing tests
  already pin every message, `propertyPath`, and boundary value through the public API. A parallel
  unit layer would duplicate them with zero new signal and manufacture exactly the mechanical churn
  #312 exists to avoid. The seam rule is **asymmetric by design**: primitives _added_ after this PR
  ship with direct tests; _moved_ ones are not retro-fitted.
- **No test for `requireConfigObject`.** Its 6 call sites are already covered
  (`config.test.ts:736-738`, `:749-751`, and the policy/cascadeAnalysis describes).
- **No snapshot work.** `src/lib/__snapshots__/` holds only `plan.test.ts.snap`.
- No coverage gate can fire — no vitest config in this repo sets `thresholds`.

### 7.4 Commands

Memory hygiene applies: `npm run test:rfmedia` does **not** set `umask`/`FORCE_COLOR` itself; only
`scripts/test-run.sh` does. Apply it manually, and always use absolute paths — the main checkout
sits at the same commit, so relative-path commands can pass vacuously against the wrong tree.

```bash
# tight loop (baseline: 286 passed, target after this PR: 287)
cd <worktree>/packages/rfmedia-cli && umask 022 && env -u FORCE_COLOR \
  npx vitest run src/lib/config.test.ts src/lib/config-init-merge.test.ts \
                 src/lib/error-formatters.test.ts src/lib/error-formatters-registration.test.ts

# full gates
npm run typecheck -w packages/rfmedia-cli     # pretypecheck runs codegen + arch checks
umask 022 && env -u FORCE_COLOR npm run test:rfmedia
npm run format
```

## 8. Ordered implementation steps

Steps 1-4 form an independently mergeable unit (`ConfigError` fully relocated, green tree).
Step 8 is independently revertable.

1. **Baseline.** Confirm `git status --porcelain` is empty and
   `wc -l packages/rfmedia-cli/src/lib/config.ts` prints **5291**; a concurrent writer was observed
   in this worktree during design, so re-derive every offset rather than trusting a stale read.
   Snapshot `git show HEAD:packages/rfmedia-cli/src/lib/config.ts > /tmp/head-config.ts`.
   _Verify:_ the 4-file vitest run reports **286 passed**.

2. **Guard first, move second.** Add the `ConfigError` case to `error-formatters.test.ts`, still
   importing from `./config.js`. _Verify:_ it passes (**287**). Writing the guard before the
   identity-critical move means the risky window is never unguarded.

3. **Relocate `ConfigError`.** Create `config-validation.ts` with the module header (admission rule
   from 2.3) and the L121-136 block verbatim. Delete it from `config.ts`; add
   `import { ConfigError } from "./config-validation.js";` near L23-25.
   _Verify:_ Gate A returns exactly one line; typecheck fails **only** in `error-formatters.ts:12`
   and `config.test.ts:61` — expected, fixed next.

4. **Repoint both consumers.** `error-formatters.ts:12` and the `config.test.ts:60-66` split (value
   imports, never `import type`).
   _Verify:_ `npm run typecheck -w packages/rfmedia-cli` clean; 4-file run at **287 passed**;
   `grep -rn 'from "./config.js"' packages/rfmedia-cli/src/lib` returns nothing.

5. **Move the eight scalar primitives.** `describeType` (L142), `rejectUnknownConfigKeys` (L212),
   `validateBoolean` (L278), `validatePositiveInteger` (L317), `validateNonNegativeInteger` (L331),
   `validateBoundedInteger` (L349), `validateString` (L369), `validateStringArray` (L384). Cut and
   paste with JSDoc; add `export`; extend the `config.ts` import block.
   _Verify:_ typecheck clean; **287 passed**; Gate B on each range.

6. **Move `validateStarRating`** (L424) with its `Number.isFinite` / YAML `.nan` rationale JSDoc
   verbatim. _Verify:_ **287 passed**; confirm the `got ${value}` suffix survived (property 7).

7. **Move `validateUrl`** (L898), adding `import { normalizeHttpUrl } from "./http-url.js";` to the
   new module, and **delete `config.ts:75` by hand** — nothing catches it (section 3.1).
   _Verify:_ `grep -n normalizeHttpUrl packages/rfmedia-cli/src/lib/config.ts` returns **nothing**;
   the full-sentence URL tests at `config.test.ts:133-142` and `:357-359` pass.

8. **Consolidate `requireConfigObject`** _(revertable; drop for a pure move)_. Add it to the new
   module with the L1691-1704 body and a domain-neutral JSDoc. Delete L1691 and L2836; repoint all
   **six** call sites: **L1712, L1733, L3059, L3070, L3081, L3121**.
   _Verify:_ `config.test.ts:736-738` and `:749-751` pass; **287 passed**.

9. **Prove non-drift.** Run Gate B across every moved range and Gate C's four mutation checks
   (section 6.1). Scan the new module for the prose traps: no `fetch(`, no `/api/v1/`.

10. **Full gates.** `npm run format`, then `npm run typecheck -w packages/rfmedia-cli`, then
    `umask 022 && env -u FORCE_COLOR npm run test:rfmedia`, then
    `npm run check:architecture -w packages/rfmedia-cli`. Re-run `git status --porcelain` to
    confirm only the intended files changed.

11. **Commit and file follow-ups.** Use
    `refactor(rfmedia): extract config validation primitives into config-validation.ts (#312)` —
    `refactor` matches the `b93e8388` shell-completions split precedent for a pure move; `chore`
    also passes commitlint and matches the issue label. In the house style of `0640943f`, the body
    should enumerate moved symbols, report the line delta (5291 → ~5090), state each refusal with
    its rule clause, and note "test suite unmodified apart from a 2-line import split plus one new
    formatter test". File follow-ups: `config-lidarr-presets.ts`, `config-redaction.ts`, the ~20
    inline `Expected object for` conversions, and the `validateDiskSpaceMargin` NaN gap (3.5).

## 9. Rejected alternatives

| Alternative                                                               | Reason for rejection                                                                                                                                                            |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep `export { ConfigError }` in `config.ts` as a shim                    | Saves 2 lines. `config.ts:27`'s `clearConfigCache` shim is **verified dead** — the repo already ran this experiment. Also preserves the six-`vi.mock` landmine (4.1).           |
| Separate `config-error.ts` (2 modules)                                    | Isolation benefit is self-defeating under a barrel and ~zero without one; issue says "a dedicated module"; no repo precedent for a ~25-line single-class flat module (2.1).     |
| `src/lib/config/` directory + barrel                                      | Contradicts the documented flat default; a `config/` directory beside a surviving `config.ts` is confusing; `secure-store/` is a 1400-line subsystem, this is ~205 lines (2.2). |
| `ConfigError` into `src/lib/errors.ts`                                    | 17 error classes live outside `errors.ts` in their owning modules; `error-formatters.ts:11-27` imports from six modules by design. Adds a needless edge.                        |
| Extract a generic `validateEnum`                                          | Would require parameterising English singular + plural labels. Verified message prose differs per validator (3.4).                                                              |
| Move `validateRatingPercent`                                              | Fails **clause 4** (1 call site). Admitting it would require the unfalsifiable "sibling" hatch two judges flagged. Nothing depends on moving it (2.3).                          |
| Move `validatePageSize` / `validateConvertFormat` / `validateRangeString` | Each fails clause 4, and each drags a domain constant or feature type across the boundary.                                                                                      |
| Move `validateDiskSpaceMargin`                                            | Fails clauses 2 and 4, and invites a NaN "harmonisation" that is a real behaviour change (3.5).                                                                                 |
| Collapse `validatePageSize` onto `validateBoundedInteger`                 | Messages are byte-identical so tests would pass — but it is a rewrite disguised as a move. Wrong risk profile for a zero-benefit chore.                                         |
| Move the 8 Lidarr preset helpers                                          | Inverted argument order + mutable DoS-budget context; a transposition hazard on exactly the pair in risk (a) (3.6).                                                             |
| Move the redaction trio                                                   | Fails clause 1 — logging redaction, not validation. Unrequested scope. Follow-up.                                                                                               |
| Convert the ~20 inline `Expected object for` throws                       | 20 hand edits, each an independent transposition chance, in a PR whose premise is that nothing changed.                                                                         |
| Add `config-validation.test.ts` unit suite                                | 263 tests already pin every message and path through the public API (7.3).                                                                                                      |

## 10. Risks and rollback

| Risk                                                                                                                                                                                                                                                                                                                         | Mitigation                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dual class identity.** Two `class ConfigError` declarations silently break `error-formatters.ts:221` (`canHandle` stops firing; users lose the `at '<path>'` prefix and all four suggestions) **and** `config.ts:4721` (validation errors escape `loadConfig` instead of falling through). Neither is caught by typecheck. | Gate A (step 3) plus the step-2 formatter test, written **before** the move.                                                                                   |
| **`export type` erasure.** `export type { ConfigError }` is silently dropped from emitted JS; `config.ts:4721` becomes a `ReferenceError`. TypeScript does **not** flag this form.                                                                                                                                           | Written prohibition (4.3); the design has no re-export at all, so the form has no place to appear.                                                             |
| **Orphaned `config.ts:75` import.** `noUnusedLocals` is unset, no ESLint exists, Prettier does not prune. Compiles and passes everything.                                                                                                                                                                                    | Explicit grep in step 7.                                                                                                                                       |
| **Message / path drift** (risk c).                                                                                                                                                                                                                                                                                           | Gates B and C (6.1). Copy-paste, never retype. Watch property 7's `got ${value}` asymmetry.                                                                    |
| **Arch-gate false positive from prose.** `fetch(` or `/api/v1/` in JSDoc fails `pretypecheck` **and** `prebuild`.                                                                                                                                                                                                            | Step 9 scan.                                                                                                                                                   |
| **Concurrent writer.** A second agent was observed writing this worktree mid-design (config.ts transiently at 5111 lines with an untracked `config-validation.ts`).                                                                                                                                                          | Step 1 precondition: clean tree, `wc -l` = 5291, re-derive offsets.                                                                                            |
| **Gates run against the wrong tree.** The main checkout is at the same commit, so relative paths can pass vacuously.                                                                                                                                                                                                         | Absolute paths everywhere; echo `pwd` and `wc -l config.ts` alongside results.                                                                                 |
| **Expectation management.** `config.ts` ends at ~5090 — a ~4% reduction, still ~10x the soft cap. Reviewers may push to fold in the ~800-line Lidarr preset block.                                                                                                                                                           | State the delta up front in the PR body. The deliverable is the seam and the admission rule, not the delta. The cap is prose-only; no `max-lines` lint exists. |

### Rollback

Every step is a separate commit. Step 8 (`requireConfigObject`) reverts alone. Steps 5-7 revert to
the step-4 state (`ConfigError` relocated, everything else in place), which is itself a coherent,
green, independently mergeable change. Full rollback is `git revert` of the range; no data
migration, no config format change, and no persisted state is involved.
