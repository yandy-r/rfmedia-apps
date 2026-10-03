# Issue #312 — Implementation plan

Executable companion to `design.md`. The design's **decisions** are settled and are not revisited
here. This document supplies the corrected facts, the exact anchor text for every edit, and a
verify block for every step.

Worktree root (`$WT` below is only shorthand for reading; always type the absolute path):

```text
/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-312-config-validation
```

Never touch `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/packages/...` without a
`.claude/worktrees/` segment. That is a different working tree at the same commit, and relative-path
commands pass vacuously against it.

**Rule for every edit in this plan: anchor on text, never on a line number.** Line numbers are given
only as orientation and become wrong the moment step 4 runs.

## 0. Preconditions

Run all four checks. Do not start until every one matches.

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-312-config-validation
pwd
git status --porcelain
wc -l packages/rfmedia-cli/src/lib/config.ts
sha256sum packages/rfmedia-cli/src/lib/config.ts
grep -rn "class ConfigError" --include="*.ts" \
  /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-312-config-validation/packages/rfmedia-cli/src
```

Expected output:

```text
/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-312-config-validation
?? packages/rfmedia-cli/docs/plans/issue-312-config-validation/
5291 packages/rfmedia-cli/src/lib/config.ts
ff4eee5c2b75011bdd7b6c2185b550f6b7897653ea909a8387269e893c701f3e  packages/rfmedia-cli/src/lib/config.ts
.../packages/rfmedia-cli/src/lib/config.ts:124:export class ConfigError extends Error {
```

If `git status --porcelain` shows anything else — in particular any file under
`packages/rfmedia-cli/src/lib/` — **stop**. A concurrent writer created
`packages/rfmedia-cli/src/lib/__gateb_probe.ts` during the design phase; a leftover copy of that
file (or any hand-built `config-validation.ts`) makes Gate A report a false failure and makes the
architecture check scan uncontrolled source. Delete it and re-run the checks. That file is
**evidence, never input** — do not copy its contents.

Baseline test counts, measured on this tree (these are the real numbers; the design's predictions
are superseded where they differ):

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-312-config-validation/packages/rfmedia-cli
umask 022 && env -u FORCE_COLOR npx vitest run \
  src/lib/config.test.ts src/lib/config-init-merge.test.ts \
  src/lib/error-formatters.test.ts src/lib/error-formatters-registration.test.ts
```

```text
 ✓ src/lib/config-init-merge.test.ts (10 tests)
 ✓ src/lib/config.test.ts (263 tests)
 ✓ src/lib/error-formatters-registration.test.ts (1 test)
 ✓ src/lib/error-formatters.test.ts (12 tests)
 Test Files  4 passed (4)
      Tests  286 passed (286)
```

Full suite baseline: **171 test files, 4310 tests, all passing**.

### 0.1 Scratch directory

Gate B needs a `HEAD` snapshot. Put it **inside the worktree but outside `src/`**, so that Prettier
resolves the repo `.prettierrc` (`printWidth: 100`) if it is ever run on it, and so that
`check:architecture` never scans it.

```bash
mkdir -p /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-312-config-validation/.312-scratch
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-312-config-validation
git show HEAD:packages/rfmedia-cli/src/lib/config.ts > .312-scratch/head-config.ts
wc -l .312-scratch/head-config.ts
```

Expected: `5291 .312-scratch/head-config.ts`.

Never snapshot to `/tmp`. Prettier resolves **no** config outside the repository and silently falls
back to `printWidth: 80`, producing dozens of false hunks concentrated in exactly the moved-primitive
region. Delete `.312-scratch/` in step 12.

## 1. Design corrections

Every row is a place where verification contradicted `design.md`. **The corrected fact wins.**

| #   | Design location              | Design says                                                                                                  | Corrected fact                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | §8 step 1                    | Tree is clean                                                                                                | A concurrent writer created `src/lib/__gateb_probe.ts` mid-design containing a second `export class ConfigError`. Precondition §0 must confirm its absence, not merely a "clean tree"                                                                                                                                                                                                                                                        |
| C2  | §8 step 4 verify             | `grep -rn 'from "./config.js"' src/lib` returns nothing                                                      | It returns **2 lines** by design (`config.test.ts`, `config-init-merge.test.ts`). §7.1 itself requires them. Scope the grep with `\| grep -v '\.test\.ts:'`                                                                                                                                                                                                                                                                                  |
| C3  | §4.1                         | "Repointing removes the **only** in-edge to `config.ts` from anywhere under `src/lib/`"                      | True for **production** modules only; two `.test.ts` in-edges remain intentionally                                                                                                                                                                                                                                                                                                                                                           |
| C4  | §8 step 8                    | "Delete L1691 and L2836"                                                                                     | Delete the **full blocks**. `requirePolicyConfigObject` carries a one-line JSDoc immediately above it that `requireLidarrCascadeAnalysisObject` does not. Deleting the declaration alone orphans a comment describing a function that no longer exists                                                                                                                                                                                       |
| C5  | §3.1 table                   | JSDoc bounds given for only 2 of 13 symbols; `rejectUnknownConfigKeys` shown with none                       | `rejectUnknownConfigKeys` has a **single-line** JSDoc; `requireLidarrCascadeAnalysisObject` has **none**. §2 below reproduces every block verbatim, JSDoc included                                                                                                                                                                                                                                                                           |
| C6  | §7.1                         | "Total churn: 2 edited lines"                                                                                | **3** edited import statements. The `ConfigError` import added to `error-formatters.test.ts` in step 3 must also be repointed, or typecheck can never go clean                                                                                                                                                                                                                                                                               |
| C7  | §8 step 3 verify             | typecheck fails in exactly 2 places                                                                          | It fails in **3**: `config.test.ts`, `error-formatters.test.ts`, `error-formatters.ts` — all `TS2459`                                                                                                                                                                                                                                                                                                                                        |
| C8  | §6.1 Gate C, 4th mutation    | Mutating `Expected object for` fails `config.test.ts:736-738` / `:749-751`                                   | **False.** Those assertions target the inline throw for `lidarr.resilience`, which §3.2 puts out of scope. Mutating both merged helpers leaves 4310/4310 green. Step 2 adds real guards                                                                                                                                                                                                                                                      |
| C9  | §7.3                         | "`requireConfigObject`'s 6 call sites are already covered"                                                   | Covered for `propertyPath` **only**; the message text has **zero** coverage repo-wide                                                                                                                                                                                                                                                                                                                                                        |
| C10 | §7.3                         | "The 263 existing tests already pin every message"                                                           | **False for 3 of the 11 moved primitives.** `validateString` (20 call sites), `validateStringArray` (5) and `rejectUnknownConfigKeys` (9) have **no** message assertion anywhere. Step 2 adds them                                                                                                                                                                                                                                           |
| C11 | §6 property 7                | Only `validateStarRating` uses the raw `got ${value}` tail                                                   | **Four** moved helpers do: `validatePositiveInteger`, `validateNonNegativeInteger`, `validateBoundedInteger`, `validateStarRating`. Only the first is test-gated today                                                                                                                                                                                                                                                                       |
| C12 | §6.1 Gate C, mutations 1-3   | Mutate the named template prefixes                                                                           | The real assertions are shorter substrings (`"Expected boolean"`, `"non-negative integer"`, `"integer between 60 and 86400"`). Mutating the prose tail of `validateBoolean` is a silent no-op across 4310 tests                                                                                                                                                                                                                              |
| C13 | §6.1 Gate B                  | `diff <(sed -n 'A,Bp' head) <(sed -n 'C,Dp' new)`                                                            | The added `export` keyword pushes **3** signatures past `printWidth: 100`, so Prettier re-wraps them into 4-line parameter lists. The raw diff reports 3 false failures. Use the token normaliser in §3 step 10                                                                                                                                                                                                                              |
| C14 | §8 step 10 and §7.4          | `npm run format`                                                                                             | **Not runnable.** Root script is `prettier --write` with no path; it exits non-zero with `No parser and no file path given`. Use `npm run format:rfmedia`, or `npm run format -- <path>` for markdown                                                                                                                                                                                                                                        |
| C15 | §7.4                         | `cd <worktree>/packages/rfmedia-cli` then `npm run typecheck -w packages/rfmedia-cli`                        | Mixing cwds. `-w packages/rfmedia-cli` fails from inside the package with `No workspaces found`. Workspace-flag commands run from the **worktree root**                                                                                                                                                                                                                                                                                      |
| C16 | Issue #312 verification plan | `npm run check:architecture`                                                                                 | No such **root** script. Use `npm run check:architecture -w packages/rfmedia-cli` from the worktree root                                                                                                                                                                                                                                                                                                                                     |
| C17 | §7.2 justification 3         | The new formatter test is the cross-seam identity guard                                                      | **Inverted.** After step 5 the formatter test imports `ConfigError` from the same module `canHandle` does, so a dual-identity split still looks self-consistent to it. `config.test.ts` is the identity guard, precisely because step 5 repoints its `ConfigError` import while all 133 throwers stay in `config.ts`. The formatter test's real value is covering the zero-coverage `error-formatters.ts` branch and asserting `.configPath` |
| C18 | §5.1 "prose traps"           | JSDoc must contain neither `fetch(` nor `/api/v1/`                                                           | `/api/v1/` in a comment is **harmless** — `collectStringLiterals` strips comments before scanning. `fetch(` / `trustedFetch(` is scanned in **raw text**, so it is forbidden in code, comments and strings alike                                                                                                                                                                                                                             |
| C19 | §3.2                         | `L1698` is an out-of-scope inline throw                                                                      | `L1698` is the **body of `requireLidarrCascadeAnalysisObject`** — in scope. The out-of-scope inline count is 23, not ~20                                                                                                                                                                                                                                                                                                                     |
| C20 | §6 property 5                | The `logWarn("Config validation error in …")` fall-through is exercised by `config.test.ts:3543-3574`        | Only the `continue` is exercised. No test asserts that `logWarn`. Accepted as-is; do not touch `loadConfig`                                                                                                                                                                                                                                                                                                                                  |
| C21 | §6 property 3 / §4.2         | "87 identity assertions"                                                                                     | 88: `toBeInstanceOf(ConfigError)` = 34, `toThrow(ConfigError)` = 54                                                                                                                                                                                                                                                                                                                                                                          |
| C22 | Assorted citations           | `:2254`, `:133-142`, generic-error branch at `L4724`, preset constants `L1759-1792`, inline throw at `L2691` | Correct values: `:2255`; `:133-135` **and** `:139-142` (two separate tests); `L4726`; `L1759-1793`; `L2692` is the message line                                                                                                                                                                                                                                                                                                              |
| C23 | §11 PR title                 | `refactor(rfmedia): … (#312)`                                                                                | Drop the trailing issue number. Squash merge auto-appends the **PR** number, so the landed subject would read `… (#312) (#NNN)`. Put `Closes #312` in the PR body                                                                                                                                                                                                                                                                            |
| C24 | §11 labels                   | Implied `type:` family                                                                                       | `type:refactor` / `type:chore` **do not exist** in this repo. Use `rfmedia-cli`, `architecture`, `priority:low`, mirroring issue #312. Never run `gh label create`                                                                                                                                                                                                                                                                           |
| C25 | §8                           | ROADMAP.md is never mentioned                                                                                | #312 is live in 6 ROADMAP.md locations plus two counters, and `docs/roadmap-archive.md` needs a row. See step 11                                                                                                                                                                                                                                                                                                                             |

Two further facts the design never records, both needed to avoid a wasted diagnosis cycle:

- **Two moved message templates intentionally survive in `config.ts`.**
  `` `Expected boolean for ${propertyPath}, got ${describeType(value)}` `` also lives in
  `requireLidarrPresetBoolean` (was L1930, stays), and
  `` `Expected non-negative integer for ${propertyPath}, got ${value}` `` also lives in an inline
  `plex` branch (was L3814, stays). Any "the template should now be absent from `config.ts`" check is
  therefore both false-positive and uninformative. Use the **declaration-count** gate in step 10.
- **The `validateStringArray` prefix trap.** `packages/rfmedia-cli/src/lib/lidarr/resilience.test.ts`
  defines a local helper named `validateStrings`. An unanchored grep for the 18 primitive names
  returns 6 false positives from it. Always anchor with `\b`.

## 2. Target module skeleton

This is the exact intended content of
`packages/rfmedia-cli/src/lib/config-validation.ts` after step 9, **before** Prettier runs. Blocks
appear in `config.ts` source order, with the merged `requireConfigObject` last.

Prettier will re-wrap exactly three signatures — `validatePositiveInteger`, `validateStringArray`,
`validateStarRating` — into 4-line parameter lists with trailing commas, because the added `export` keyword
pushes them past `printWidth: 100`. **That is correct output. Do not undo it.**

The header must contain no `fetch(` and no `trustedFetch(` (raw-text architecture rule). `/api/v1/`
in comments is fine but there is no reason to write it.

```typescript
/**
 * Shared configuration validation primitives for rfmedia CLI.
 *
 * Declares `ConfigError` and the domain-generic assertion helpers used by every
 * `validateXxxConfig` section validator in `./config.js`.
 *
 * Admission rule — a helper belongs here **iff all four hold**:
 *
 * 1. Its signature is `(value: unknown, …, propertyPath: string, configPath: string)` and it
 *    throws `new ConfigError(message, configPath, propertyPath)`.
 * 2. Its message text names no feature domain — no "convert format", "range", "page size",
 *    "preset", "disk space".
 * 3. Its imports are confined to `./http-url.js`; it pulls in no `../types/*` feature type.
 * 4. It has at least 2 call sites spanning at least 2 distinct top-level config sections.
 *
 * The rule has no exceptions and no sibling escape hatch. Helpers that fail any clause stay in
 * `./config.js` beside the validator that owns their prose.
 *
 * Honesty note: `validateStarRating` has a domain-flavoured *name* but a domain-free *contract*
 * and message. It is admitted under clause 4 as a shared cross-section value domain
 * (copy + plex + policy), not because it is "generic".
 *
 * Message-shape note: `validatePositiveInteger`, `validateNonNegativeInteger`,
 * `validateBoundedInteger` and `validateStarRating` end with the raw `got ${value}`; the rest end
 * with `got ${describeType(value)}`. The asymmetry is load-bearing — `got NaN` must not become
 * `got number`. Do not harmonise it.
 *
 * Primitives added here after this module was created ship with direct unit tests. The primitives
 * moved in during issue #312 are covered through `validateConfig` in `./config.test.ts` and are
 * deliberately not retro-fitted.
 */

import { normalizeHttpUrl } from "./http-url.js";

/**
 * Custom error class for configuration validation errors.
 */
export class ConfigError extends Error {
  /** Path to the config file that caused the error */
  readonly configPath: string;
  /** JSON path to the invalid property (e.g., "copy.workers") */
  readonly propertyPath?: string;

  constructor(message: string, configPath: string, propertyPath?: string) {
    super(message);
    this.name = "ConfigError";
    this.configPath = configPath;
    this.propertyPath = propertyPath;
  }
}

/**
 * Returns a human-readable type description for error messages.
 * Handles JavaScript quirks where typeof null === 'object'.
 */
export function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Rejects keys outside one exact configuration object contract. */
export function rejectUnknownConfigKeys(
  raw: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  propertyPath: string,
  configPath: string,
): void {
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      const keyPath = `${propertyPath}.${key}`;
      throw new ConfigError(`Unknown property ${keyPath}`, configPath, keyPath);
    }
  }
}

/**
 * Validates that a value is a boolean.
 */
export function validateBoolean(value: unknown, propertyPath: string, configPath: string): boolean {
  if (typeof value !== "boolean") {
    throw new ConfigError(`Expected boolean for ${propertyPath}, got ${describeType(value)}`, configPath, propertyPath);
  }
  return value;
}

/**
 * Validates that a value is a positive integer.
 */
export function validatePositiveInteger(value: unknown, propertyPath: string, configPath: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`Expected positive integer for ${propertyPath}, got ${value}`, configPath, propertyPath);
  }
  return value;
}

/**
 * Validates that a value is a non-negative integer (0 or positive).
 */
export function validateNonNegativeInteger(value: unknown, propertyPath: string, configPath: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ConfigError(`Expected non-negative integer for ${propertyPath}, got ${value}`, configPath, propertyPath);
  }
  return value;
}

/**
 * Validates that a value is an integer within an inclusive range.
 */
export function validateBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  propertyPath: string,
  configPath: string,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ConfigError(
      `Expected integer between ${minimum} and ${maximum} for ${propertyPath}, got ${value}`,
      configPath,
      propertyPath,
    );
  }
  return value;
}

/**
 * Validates that a value is a non-empty string.
 */
export function validateString(value: unknown, propertyPath: string, configPath: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(
      `Expected non-empty string for ${propertyPath}, got ${describeType(value)}`,
      configPath,
      propertyPath,
    );
  }
  return value;
}

/**
 * Validates that a value is an array of strings.
 * Filters out empty strings (including whitespace-only strings) from the result.
 */
export function validateStringArray(value: unknown, propertyPath: string, configPath: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new ConfigError(`Expected array of strings for ${propertyPath}`, configPath, propertyPath);
  }
  // Filter out empty strings (including whitespace-only)
  return (value as string[]).filter((s) => s.trim() !== "");
}

/**
 * Validates that a value is a valid star rating (1.0-5.0).
 * Supports both integer and float values.
 *
 * `Number.isFinite` is deliberate: YAML's `.nan` / `.inf` literals load as JS
 * `NaN` / `Infinity`, and a bare `value < 1 || value > 5` bounds check is false
 * for `NaN`. A `NaN` threshold would then survive into the resolved policy and
 * make every `>=` comparison false, silently disabling a rating veto.
 */
export function validateStarRating(value: unknown, propertyPath: string, configPath: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 5) {
    throw new ConfigError(
      `Expected number between 1.0 and 5.0 for ${propertyPath}, got ${value}`,
      configPath,
      propertyPath,
    );
  }
  return value;
}

/**
 * Validates that a value is a valid URL.
 */
export function validateUrl(value: unknown, propertyPath: string, configPath: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(
      `Expected non-empty URL string for ${propertyPath}, got ${describeType(value)}`,
      configPath,
      propertyPath,
    );
  }

  if (!normalizeHttpUrl(value).ok) {
    throw new ConfigError(
      `Invalid URL format for ${propertyPath}: ${value}. Must be http:// or https://`,
      configPath,
      propertyPath,
    );
  }

  return value;
}

/** Narrows a nested configuration value to a plain object, or throws with its exact path. */
export function requireConfigObject(value: unknown, propertyPath: string, configPath: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`Expected object for ${propertyPath}, got ${describeType(value)}`, configPath, propertyPath);
  }
  return value as Record<string, unknown>;
}
```

### 2.1 The `config.ts` import statement, per step

Each step below replaces the whole `./config-validation.js` import statement in `config.ts`. Locate
it with `grep -n 'config-validation' packages/rfmedia-cli/src/lib/config.ts` and replace it with the
literal text given for that step. Steps 6-9 all produce multi-line forms; Prettier leaves them
unchanged.

Final form after step 9:

```typescript
import {
  ConfigError,
  describeType,
  rejectUnknownConfigKeys,
  requireConfigObject,
  validateBoolean,
  validateBoundedInteger,
  validateNonNegativeInteger,
  validatePositiveInteger,
  validateStarRating,
  validateString,
  validateStringArray,
  validateUrl,
} from "./config-validation.js";
```

This must be a **value** import. Never `import type`, never inline `{ type ConfigError }` — under
`verbatimModuleSyntax: true` the binding is erased and `config.ts`'s `instanceof ConfigError` becomes
a runtime `ReferenceError` that TypeScript does not flag.

## 3. Step-by-step edits

Thirteen steps. The tree is **green from step 5 onward**; steps 4 is the only red window.

Global rules for every step:

- Run every command from the **worktree root** unless the step says otherwise.
- Finish each step with `npm run format:rfmedia` **before** running its verify block, so the bytes
  you verify are the bytes lefthook will commit.
- Never add `export { ConfigError } from "./config-validation.js";` to `config.ts`. If typecheck
  complains, fix the importing file. `config.ts:27`'s `clearConfigCache` shim is verified dead and a
  second shim re-arms the six-`vi.mock` landmine.

### Step 1 — Baseline and snapshot

Do §0 and §0.1. No edits.

**VERIFY**

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-312-config-validation/packages/rfmedia-cli
umask 022 && env -u FORCE_COLOR npx vitest run \
  src/lib/config.test.ts src/lib/config-init-merge.test.ts \
  src/lib/error-formatters.test.ts src/lib/error-formatters-registration.test.ts
```

Expected: `Test Files  4 passed (4)` / `Tests  286 passed (286)`.

### Step 2 — Guard the three uncovered primitives and the raw-value tails

**Why first:** corrections C8-C12 establish that `validateString`, `validateStringArray`,
`rejectUnknownConfigKeys` and `requireConfigObject` have **no** message coverage, and that 3 of the
4 raw-`${value}` tails are ungated. Moving them before guarding them means a copy-paste-then-tidy
edit ships a user-visible message change with 4310/4310 green.

**File:** `packages/rfmedia-cli/src/lib/config.test.ts`

**Anchor** (unique; `grep -cF 'describe("smart filter separation validation", () => {' config.test.ts`
returns `1`):

```typescript
  describe("smart filter separation validation", () => {
```

Insert the following **immediately above** that line, inside the top-level
`describe("validateConfig", …)`. All ten message strings were measured against the current tree.

```typescript
// Issue #312 drift guards. These pin the exact message text of the primitives that
// move to ./config-validation.js. Before this block, validateString,
// validateStringArray, rejectUnknownConfigKeys and requireConfigObject had zero
// message coverage, and three of the four raw `got ${value}` tails were ungated.
describe("moved validation primitive message contracts", () => {
  it("pins validateBoolean's full message tail", () => {
    expect(() => validateConfig({ plex: { cache: { enabled: "yes" } } }, testConfigPath)).toThrow(
      "Expected boolean for plex.cache.enabled, got string",
    );
  });

  it("pins validatePositiveInteger's raw value tail", () => {
    expect(() => validateConfig({ lidarr: { timeoutMs: 0 } }, testConfigPath)).toThrow(
      "Expected positive integer for lidarr.timeoutMs, got 0",
    );
  });

  it("pins validateNonNegativeInteger's raw value tail", () => {
    expect(() => validateConfig({ plex: { defaultFilters: { minPlays: -5 } } }, testConfigPath)).toThrow(
      "Expected non-negative integer for plex.defaultFilters.minPlays, got -5",
    );
  });

  it("pins validateBoundedInteger's raw value tail", () => {
    expect(() => validateConfig({ plex: { auth: { refreshMarginSeconds: 10 } } }, testConfigPath)).toThrow(
      "Expected integer between 60 and 86400 for plex.auth.refreshMarginSeconds, got 10",
    );
  });

  it("pins validateStarRating's raw value tail", () => {
    expect(() =>
      validateConfig({ policy: { rules: { "rating-quality-upgrade": { minRating: 9 } } } }, testConfigPath),
    ).toThrow("Expected number between 1.0 and 5.0 for policy.rules.rating-quality-upgrade.minRating, got 9");
  });

  it("pins validateString's message", () => {
    expect(() => validateConfig({ clean: { protect: 5 } }, testConfigPath)).toThrow(
      "Expected non-empty string for clean.protect, got number",
    );
  });

  it("pins validateStringArray's message", () => {
    expect(() => validateConfig({ clean: { exclude: 5 } }, testConfigPath)).toThrow(
      "Expected array of strings for clean.exclude",
    );
  });

  it("pins validateStringArray's empty-entry filtering contract", () => {
    const config = validateConfig({ clean: { exclude: ["a", " ", ""] } }, testConfigPath);

    expect(config.clean?.exclude).toEqual(["a"]);
  });

  it("pins rejectUnknownConfigKeys's message", () => {
    expect(() => validateConfig({ policy: { rules: { "typo-rule": {} } } }, testConfigPath)).toThrow(
      "Unknown property policy.rules.typo-rule",
    );
  });

  it("pins requireConfigObject's message at both call-site families", () => {
    expect(() => validateConfig({ policy: { rules: [] } }, testConfigPath)).toThrow(
      "Expected object for policy.rules, got array",
    );
    expect(() => validateConfig({ lidarr: { cascadeAnalysis: [] } }, testConfigPath)).toThrow(
      "Expected object for lidarr.cascadeAnalysis, got array",
    );
  });
});
```

**VERIFY**

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-312-config-validation
npm run format:rfmedia
cd packages/rfmedia-cli
umask 022 && env -u FORCE_COLOR npx vitest run \
  src/lib/config.test.ts src/lib/config-init-merge.test.ts \
  src/lib/error-formatters.test.ts src/lib/error-formatters-registration.test.ts
```

Expected: `✓ src/lib/config.test.ts (273 tests)` and `Tests  296 passed (296)`.

### Step 3 — Add the `ConfigError` formatter test

**Why:** `error-formatters.ts:219-235` is the only production consumer of `ConfigError` outside
`config.ts` and has **zero** coverage (`grep -c "ConfigError" error-formatters.test.ts` returns `0`).
It is also the only place `.configPath` is ever read, and no test asserts `.configPath` today. Per
C17 this is **not** the identity guard — `config.test.ts` is — but the branch must be covered before
the class relocates.

**File:** `packages/rfmedia-cli/src/lib/error-formatters.test.ts`

Add the import, anchored on (unique, `grep -cF` returns `1`):

```typescript
import { SourceSelectionError } from "./paths-yaml.js";
```

Insert immediately **below** it:

```typescript
import { ConfigError } from "./config.js";
```

Then add a test. The file has one flat top-level `describe("registerRfmediaErrorFormatters", …)`
with 12 sibling `it(...)` blocks and a `beforeAll` registering the formatters. Append this as the
last `it` inside that describe (anchor on the final `});` of the file — verify by eye that you are
inside the describe, not after it):

```typescript
it("formats ConfigError with property path and config file guidance", () => {
  const error = new ConfigError("Expected boolean for plex.cache.enabled", "/test/config.yaml", "plex.cache.enabled");
  const result = formatError(error);

  expect(result.message).toBe("Invalid configuration at 'plex.cache.enabled': Expected boolean for plex.cache.enabled");
  expect(result.suggestions).toContain("Check the configuration in /test/config.yaml");
  expect(result.suggestions).toContain("Verify the value of 'plex.cache.enabled'");
  expect(result.exitCode).toBe(1);
});
```

The import points at `./config.js` for now. **Step 5 repoints it.** This is design correction C6/C7.

**VERIFY**

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-312-config-validation
npm run format:rfmedia
cd packages/rfmedia-cli
umask 022 && env -u FORCE_COLOR npx vitest run \
  src/lib/config.test.ts src/lib/config-init-merge.test.ts \
  src/lib/error-formatters.test.ts src/lib/error-formatters-registration.test.ts
```

Expected: `✓ src/lib/error-formatters.test.ts (13 tests)` and `Tests  297 passed (297)`.

### Step 4 — Relocate `ConfigError` (the only red window)

**Create** `packages/rfmedia-cli/src/lib/config-validation.ts` containing, in order:

1. The full module header comment from §2.
2. `import { normalizeHttpUrl } from "./http-url.js";` — **omit for now**; it has no consumer until
   step 8 and an unused import is not an error but is noise. Add it in step 8.
3. The `ConfigError` block from §2, verbatim.

**Delete from `config.ts`** the identical block (§2's `ConfigError` block; it is already `export`ed,
so the text is byte-identical). Anchor:
`grep -cF 'export class ConfigError extends Error {' config.ts` returns `1`. Delete the JSDoc line
`/**` … `*/` above it through the closing `}` of the class, plus the trailing blank separator.

**Add** to `config.ts`, immediately **below** this anchor (unique, `grep -cF` returns `1`):

```typescript
import { getConfigCache, isConfigCacheValid, updateConfigCache } from "./loaded-config.js";
```

insert:

```typescript
import { ConfigError } from "./config-validation.js";
```

**VERIFY**

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-312-config-validation
grep -rn "class ConfigError" --include="*.ts" \
  packages/rfmedia-cli/src
npm run typecheck -w packages/rfmedia-cli 2>&1 | grep -E "TS2459|error TS" | sort
```

Expected — Gate A returns exactly **one** line, in `config-validation.ts`:

```text
packages/rfmedia-cli/src/lib/config-validation.ts:<n>:export class ConfigError extends Error {
```

Expected — typecheck fails at exactly **three** sites, all `TS2459` (correction C7):

```text
src/lib/config.test.ts(62,3): error TS2459: Module './config.js' declares 'ConfigError' locally, but it is not exported.
src/lib/error-formatters.test.ts(...): error TS2459: ...
src/lib/error-formatters.ts(12,10): error TS2459: ...
```

If a **fourth** site appears, or if any site is not `TS2459`, stop and diagnose. Do **not** make the
error go away by adding a re-export to `config.ts`.

### Step 5 — Repoint all three consumers (tree returns to green)

Three edits. Correction C6: the design lists only two.

**5a — `packages/rfmedia-cli/src/lib/error-formatters.ts`.** Anchor (`grep -cF` returns `1`):

```typescript
import { ConfigError } from "./config.js";
```

Replace with:

```typescript
import { ConfigError } from "./config-validation.js";
```

**5b — `packages/rfmedia-cli/src/lib/error-formatters.test.ts`.** Same anchor text, same
replacement. (The two files each contain exactly one such line; edit them one file at a time.)

**5c — `packages/rfmedia-cli/src/lib/config.test.ts`.** Anchor (`grep -cF` on the multi-line block
returns `1`):

```typescript
import { validateConfig, ConfigError, getInteractiveConfig, loadConfig, mergeConfigs } from "./config.js";
```

Replace with:

```typescript
import { validateConfig, getInteractiveConfig, loadConfig, mergeConfigs } from "./config.js";
import { ConfigError } from "./config-validation.js";
```

This split is what makes `config.test.ts` the cross-seam identity guard (C17): its 88 identity
assertions now bind a class imported from `config-validation.js` against errors thrown from
`config.ts`. **Never revert this to `./config.js`.**

**VERIFY**

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-312-config-validation
npm run format:rfmedia
npm run typecheck -w packages/rfmedia-cli
grep -rn 'from "./config.js"' packages/rfmedia-cli/src/lib --include="*.ts" | grep -v '\.test\.ts:'
grep -n 'export .*ConfigError' packages/rfmedia-cli/src/lib/config.ts
cd packages/rfmedia-cli
umask 022 && env -u FORCE_COLOR npx vitest run \
  src/lib/config.test.ts src/lib/config-init-merge.test.ts \
  src/lib/error-formatters.test.ts src/lib/error-formatters-registration.test.ts
```

Expected:

- typecheck exits `0` (`pretypecheck` prints `# pass 66` for the architecture tests and
  `OK: Plex/Lidarr dependency direction …`).
- The scoped `from "./config.js"` grep prints **nothing** (correction C2 — the unscoped form returns
  2 test lines by design).
- The `export .*ConfigError` grep prints **nothing** (no shim was added).
- `Tests  297 passed (297)`.

### Step 6 — Move the eight scalar primitives

Symbols, in `config.ts` source order: `describeType`, `rejectUnknownConfigKeys`, `validateBoolean`,
`validatePositiveInteger`, `validateNonNegativeInteger`, `validateBoundedInteger`, `validateString`,
`validateStringArray`.

For each: **append** the §2 block (with `export`) to `config-validation.ts` in the order listed, and
**delete** the corresponding block from `config.ts`. Each declaration line is a unique anchor —
`grep -cF` on any of the eight signature lines in §2 (with the `export` keyword stripped) returns `1`. Delete
the **preceding JSDoc too**:

- `describeType` — 4-line JSDoc.
- `rejectUnknownConfigKeys` — **single-line** JSDoc `/** Rejects keys outside one exact
configuration object contract. */` (correction C5). Easy to leave orphaned.
- The other six — 3- or 4-line JSDoc blocks.

Do **not** retype anything; copy from §2 or from the block you are deleting.

Replace the `config.ts` import statement (§2.1) with:

```typescript
import {
  ConfigError,
  describeType,
  rejectUnknownConfigKeys,
  validateBoolean,
  validateBoundedInteger,
  validateNonNegativeInteger,
  validatePositiveInteger,
  validateString,
  validateStringArray,
} from "./config-validation.js";
```

**Read `validateStringArray`'s body by hand after formatting.** Line 2 of its body is
`return (value as string[]).filter((s) => s.trim() !== "");`. It looks like a redundant cast plus a
no-op filter; it is the **only** thing dropping empty and whitespace-only entries from
`clean.exclude`, `plex.defaultFilters.excludeGenres`, `plugins.commands[].args`,
`plugins.additionalDirectories` and `plugins.disabled`. Removing it passes tsc, the architecture
check, and (before step 2) the whole 4310-test suite. Step 2's filtering-contract test is the only
thing that catches it.

**VERIFY**

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-312-config-validation
npm run format:rfmedia
npm run typecheck -w packages/rfmedia-cli
grep -cE '^(export )?(function|class) (ConfigError|describeType|rejectUnknownConfigKeys|validateBoolean|validatePositiveInteger|validateNonNegativeInteger|validateBoundedInteger|validateStringArray|validateString|validateStarRating|validateUrl|requireConfigObject)\b' \
  packages/rfmedia-cli/src/lib/config.ts
cd packages/rfmedia-cli
umask 022 && env -u FORCE_COLOR npx vitest run \
  src/lib/config.test.ts src/lib/config-init-merge.test.ts \
  src/lib/error-formatters.test.ts src/lib/error-formatters-registration.test.ts
```

Expected: typecheck exits `0`; the declaration-count grep prints `2` (only
`requireLidarrCascadeAnalysisObject` / `requirePolicyConfigObject` remain, and they are not in the
alternation — so it prints `2` for `validateStarRating` and `validateUrl`); `Tests  297 passed (297)`.

### Step 7 — Move `validateStarRating`

Move the block from §2 including its **9-line** JSDoc, of which lines 5-8 are the `Number.isFinite` /
YAML `.nan` rationale. That rationale must survive verbatim — it is the written reason the
`got ${value}` tail must not be harmonised.

Extend the `config.ts` import statement by adding `validateStarRating` (alphabetical position: after
`validatePositiveInteger`, before `validateString`).

**VERIFY**

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-312-config-validation
npm run format:rfmedia
npm run typecheck -w packages/rfmedia-cli
grep -c 'got \${value}' packages/rfmedia-cli/src/lib/config-validation.ts
grep -c 'Number.isFinite' packages/rfmedia-cli/src/lib/config-validation.ts
cd packages/rfmedia-cli
umask 022 && env -u FORCE_COLOR npx vitest run src/lib/config.test.ts
```

Expected: typecheck exits `0`; `got ${value}` count is **4**; `Number.isFinite` count is **2** (the
JSDoc mention plus the guard); `Tests  273 passed (273)`.

### Step 8 — Move `validateUrl` and delete the orphaned import

Move the `validateUrl` block from §2, and add to `config-validation.ts` — directly under the module
header, above `ConfigError`:

```typescript
import { normalizeHttpUrl } from "./http-url.js";
```

Then **delete by hand** from `config.ts` (unique anchor, `grep -cF` returns `1`):

```typescript
import { normalizeHttpUrl } from "./http-url.js";
```

Nothing catches this one. `noUnusedLocals` is unset, the repo has no ESLint, Prettier does not prune
imports, and lefthook runs only Prettier / tests / commitlint.

Extend the `config.ts` import statement with `validateUrl` (last alphabetically).

**VERIFY**

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-312-config-validation
npm run format:rfmedia
npm run typecheck -w packages/rfmedia-cli
grep -n "http-url" packages/rfmedia-cli/src/lib/config.ts
grep -n "normalizeHttpUrl" packages/rfmedia-cli/src/lib/config-validation.ts
cd packages/rfmedia-cli
umask 022 && env -u FORCE_COLOR npx vitest run src/lib/config.test.ts
```

Expected: typecheck exits `0`; `http-url` in `config.ts` prints **nothing**; `normalizeHttpUrl` in
`config-validation.ts` prints exactly **2** lines (the import and the guard); `Tests  273 passed
(273)`. The full-sentence URL tests (`config.test.ts:133-135` and `:139-142`, both plex.url, and
`:357-359`, lidarr.baseUrl) are inside that run.

### Step 9 — Consolidate `requireConfigObject` (independently revertable)

`requireLidarrCascadeAnalysisObject` and `requirePolicyConfigObject` are **verified byte-identical
apart from the function name** — normalised diff empty, identical sha256, both 386 bytes, identical
signature `(value, propertyPath, configPath)`. There is no argument-order hazard at any of the six
call sites.

**9a.** Append the `requireConfigObject` block from §2 to `config-validation.ts`. Its JSDoc reuses
`requirePolicyConfigObject`'s one-liner with "policy" generalised to "configuration".

**9b.** Rename both names to `requireConfigObject` across the whole file in **one** substitution.
Six of the call sites include a byte-identical pair (`const raw = requireLidarrCascadeAnalysisObject(
value, propertyPath, configPath);` appears twice) and a byte-identical triple
(`requirePolicyConfigObject(` opening three multi-line calls), so per-site `Edit` calls abort on
non-uniqueness:

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-312-config-validation
sed -i 's/requireLidarrCascadeAnalysisObject/requireConfigObject/g; s/requirePolicyConfigObject/requireConfigObject/g' \
  packages/rfmedia-cli/src/lib/config.ts
```

**9c.** Delete the two now-duplicate declarations from `config.ts`. **Delete full blocks, not
declaration lines** (correction C4): the former `requirePolicyConfigObject` carries the one-line
JSDoc `/** Narrows a nested policy value to a plain object, or throws with its exact path. */`
immediately above it; the former `requireLidarrCascadeAnalysisObject` has **no** preceding comment
(the line above it is blank). After the rename both bodies are identical, so use surrounding context
to delete each. Confirm with the declaration-count gate below.

**9d.** Extend the `config.ts` import statement with `requireConfigObject` (after
`rejectUnknownConfigKeys`) — the §2.1 final form.

**9e.** Run `npm run format:rfmedia`. Expect **exactly one** reflow hunk in `config.ts`: the
discovery-seed call (was L3081-3086) collapses from 5 lines to 1, because the shortened name brings
it to 96 chars, under `printWidth: 100`. Its two siblings keep longer path literals and stay wrapped.
This is correct.

**VERIFY**

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-312-config-validation
npm run typecheck -w packages/rfmedia-cli
grep -cE '^(export )?(function|class) (ConfigError|describeType|rejectUnknownConfigKeys|validateBoolean|validatePositiveInteger|validateNonNegativeInteger|validateBoundedInteger|validateStringArray|validateString|validateStarRating|validateUrl|requireConfigObject)\b' \
  packages/rfmedia-cli/src/lib/config.ts
grep -cE '^(export )?(function|class) (ConfigError|describeType|rejectUnknownConfigKeys|validateBoolean|validatePositiveInteger|validateNonNegativeInteger|validateBoundedInteger|validateStringArray|validateString|validateStarRating|validateUrl|requireConfigObject)\b' \
  packages/rfmedia-cli/src/lib/config-validation.ts
grep -cE "requireLidarrCascadeAnalysisObject|requirePolicyConfigObject" packages/rfmedia-cli/src/lib/config.ts
grep -c "requireConfigObject(" packages/rfmedia-cli/src/lib/config.ts
cd packages/rfmedia-cli
umask 022 && env -u FORCE_COLOR npx vitest run src/lib/config.test.ts
```

Expected: typecheck exits `0`; `config.ts` declaration count **0**; `config-validation.ts`
declaration count **12**; old-name count **0** (grep exits 1); `requireConfigObject(` count **6**
(the call sites — the declaration is gone from this file); `Tests  273 passed (273)`.

Step 2's `requireConfigObject` message test is the guard here. The design's cited assertions
(`config.test.ts:736-738`, `:749-751`) target the out-of-scope `lidarr.resilience` inline throw and
prove nothing (correction C8).

### Step 10 — Prove non-drift

**Gate A — single class identity, scoped to this worktree's `src/`.** The design's
`packages/`-relative form passes identically from the main checkout, which is the tree this gate
exists to distinguish from.

```bash
grep -rn "class ConfigError" --include="*.ts" \
  /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-312-config-validation/packages/rfmedia-cli/src
```

Expected: exactly one line, ending in `src/lib/config-validation.ts`.

**Gate B — token-normalised range equality.** Immune to the `export` keyword, to Prettier's three
signature re-wraps, and to trailing commas (correction C13). Run **after** `format:rfmedia`.

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-312-config-validation
norm() { sed -E 's/(^|[^A-Za-z0-9_$])export[[:space:]]+/\1/g' | tr -d '[:space:]' | sed 's/,)/)/g; s/,}/}/g; s/,]/]/g'; }
H=.312-scratch/head-config.ts
N=packages/rfmedia-cli/src/lib/config-validation.ts
for r in 121,136 138,146 211,224 275,287 314,326 328,344 346,364 366,378 380,394 415,433 895,916 1691,1704; do
  sed -n "${r}p" "$H"
done | norm > .312-scratch/head-tokens.txt
sed -n '/^import { normalizeHttpUrl/,$p' "$N" | grep -v '^import { normalizeHttpUrl' | norm > .312-scratch/new-tokens.txt
diff .312-scratch/head-tokens.txt .312-scratch/new-tokens.txt && echo "GATE B: IDENTICAL"
```

Those twelve ranges are the JSDoc-inclusive block bounds in the pristine 5291-line `HEAD` file,
re-verified against it. Note the last one (`1691,1704`) is the `requireLidarrCascadeAnalysisObject`
body, which becomes `requireConfigObject` — so also confirm the only token difference the normaliser
cannot absorb:

```bash
diff <(sed 's/requireLidarrCascadeAnalysisObject/REQ/' .312-scratch/head-tokens.txt) \
     <(sed 's/requireConfigObject/REQ/' .312-scratch/new-tokens.txt)
```

Expected: the second diff is empty (the JSDoc one-liner differs — `policy value` became
`configuration value` — so if the first diff shows only that comment, that is the expected and only
acceptable difference).

**Gate C — mutation checks, re-anchored to substrings the tests actually assert** (correction C12).
For each, change one character **inside the quoted assertion substring**, run, confirm the named test
fails, then revert:

| Template in `config-validation.ts`                                                     | Mutate inside  | Must fail                                                     |
| -------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------- |
| `Expected boolean for ${propertyPath}, got ${describeType(value)}`                     | `boolean`      | step-2 guard + `config.test.ts` "Expected boolean" assertions |
| `Expected non-negative integer for ${propertyPath}, got ${value}`                      | `non-negative` | step-2 guard + `:1394-1396`                                   |
| `Expected integer between ${minimum} and ${maximum} for ${propertyPath}, got ${value}` | `between`      | step-2 guard + `:2326-2328`                                   |
| `Expected non-empty string for ${propertyPath}, got ${describeType(value)}`            | `non-empty`    | step-2 `validateString` guard                                 |
| `Expected array of strings for ${propertyPath}`                                        | `strings`      | step-2 `validateStringArray` guard                            |
| `Unknown property ${keyPath}`                                                          | `Unknown`      | step-2 `rejectUnknownConfigKeys` guard                        |
| `Expected object for ${propertyPath}, got ${describeType(value)}`                      | `object`       | step-2 `requireConfigObject` guard                            |

Do **not** mutate the `for` or `Expected` prose tails of `validateBoolean` — those are outside every
assertion substring and the mutation is a silent no-op across all 4310 tests.

**Message-shape gate** (correction C11; mechanical, no test dependency):

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-312-config-validation
grep -c 'got \${value}' packages/rfmedia-cli/src/lib/config-validation.ts
grep -c 'got \${describeType(value)}' packages/rfmedia-cli/src/lib/config-validation.ts
```

Expected: **5** and **5** — four code sites each, plus the module header's own quotation of both
templates in its message-shape note.

**Prose-trap scan** (correction C18 — `/api/v1/` in comments is harmless; `fetch(` anywhere is not):

```bash
grep -nE '\b(fetch|trustedFetch)[[:space:]]*\(' \
  /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-312-config-validation/packages/rfmedia-cli/src/lib/config-validation.ts
```

Expected: no output (exit 1).

**Orphaned-comment eyeball.** After every cut, read the ~6 lines above and below each deletion point
in `config.ts` — nothing (tsc, Prettier, 4310 tests, `check:architecture`) can see a stray JSDoc left
describing a function that moved. The two at highest risk are `rejectUnknownConfigKeys`'s one-liner
and `requirePolicyConfigObject`'s one-liner.

### Step 11 — ROADMAP.md and archive

The design never mentions ROADMAP.md, but #312 is live in six places plus two counters, and every
comparable merged PR (`0640943f`/#309, `79d8e8c3`/#315, `c9b8604f`/#310, `b5cc7475`/#303) updated it.
Make these edits in `ROADMAP.md` at the worktree root:

| Anchor text                                                                                             | Edit                                                                                                               |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `**Last updated:** 2026-07-31`                                                                          | Set to today's date                                                                                                |
| `**Open issues:** 85 (rfapps 36 · rfmedia 49)`                                                          | Change to `84 (rfapps 36 · rfmedia 48)`                                                                            |
| `Near-term focus is **Sprint 1** (the remaining #209 policy follow-ups #312–#314, with #311 shipped`    | Drop #312 from the remaining set: `… follow-ups #313–#314, with #311 and #312 shipped`                             |
| The `\| 1     \| [#312](…)` Sprint 1 table row                                                          | Delete the row; renumber the remaining rows to `1` and `2`                                                         |
| `Layer 3 — Plex–Lidarr intelligence  (#207–#209, #221, #284–#285, #311 shipped; #312–#314 filed)`       | `(#207–#209, #221, #284–#285, #311–#312 shipped; #313–#314 filed)`                                                 |
| The Phase D follow-ups table row for #312 (currently mis-describes the work as "seven primitives")      | Delete the row and note in the paragraph above it that #312 shipped via PR #NNN                                    |
| `<summary>Click to expand (#38, #50, #54–#55, #118–#143, #286–#287, #305–#308, #312)</summary>`         | Drop `, #312`; decrement the section heading count `### Low priority — docs, polish & future ideas (28)` to `(27)` |
| The low-priority table row `\| [#312](…) \| Extract config validation primitives from \`config.ts\` \|` | Delete the row                                                                                                     |

In `docs/roadmap-archive.md`, add a row to the issue→PR table (the block whose last existing row is
`rfmedia copy config retention`):

```text
| rfmedia config validation primitives  | [#312](https://github.com/yandy-r/rfmedia-apps/issues/312) | [#NNN](https://github.com/yandy-r/rfmedia-apps/pull/NNN) |
```

**VERIFY**

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-312-config-validation
grep -n "312" ROADMAP.md
grep -n "312" docs/roadmap-archive.md
npm run format -- ROADMAP.md docs/roadmap-archive.md
npx --no -- markdownlint-cli2 ROADMAP.md docs/roadmap-archive.md
```

Expected: `ROADMAP.md` prints nothing (or only historical prose you intentionally kept);
`roadmap-archive.md` prints the new row; markdownlint reports `Summary: 0 error(s)`.

### Step 12 — Full gates and commits

Format the design doc and this plan before staging — lefthook's pre-commit Prettier glob includes
`md` with `stage_fixed: true`, so an unformatted markdown file is rewritten in place at commit time.

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-312-config-validation
npm run format -- packages/rfmedia-cli/docs/plans/issue-312-config-validation/design.md \
                  packages/rfmedia-cli/docs/plans/issue-312-config-validation/plan.md
rm -rf .312-scratch
git status --porcelain
```

Expected `git status --porcelain`, exactly:

```text
 M ROADMAP.md
 M docs/roadmap-archive.md
 M packages/rfmedia-cli/src/lib/config.test.ts
 M packages/rfmedia-cli/src/lib/config.ts
 M packages/rfmedia-cli/src/lib/error-formatters.test.ts
 M packages/rfmedia-cli/src/lib/error-formatters.ts
?? packages/rfmedia-cli/docs/plans/issue-312-config-validation/
?? packages/rfmedia-cli/src/lib/config-validation.ts
```

Then run the full gate sequence in §5. Then commit in three interior commits (mirroring `79d8e8c3`,
which used a dedicated interior `docs(roadmap):` commit). Squash merge means only the PR title lands
on `master`, so interior subjects are for review readability and rollback granularity:

1. `refactor(rfmedia): extract config validation primitives into config-validation.ts` — the four
   source files.
2. `docs(internal): record issue-312 config-validation design and plan` — the plan directory
   (mandatory prefix for anything under `docs/plans/`).
3. `docs(roadmap): record config validation primitive extraction` — ROADMAP.md + archive.

### Step 13 — Pull request

Title (correction C23 — **no** trailing issue number):

```text
refactor(rfmedia): extract config validation primitives into config-validation.ts
```

Labels (correction C24), mirroring issue #312 exactly:

```bash
gh pr create --label rfmedia-cli --label architecture --label priority:low ...
```

Never `gh label create`. `type:refactor` and `type:chore` do not exist in this repo.

Body: use `.github/pull_request_template.md` verbatim. See §6 for the required content of each
section.

## 4. Failure-mode prevention matrix

| Failure mode                                                                                                        | Severity     | Prevented by                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validateStringArray`'s empty-string filter deleted during the move; every gate stays green                         | ships-a-bug  | Step 2 test #8 (filtering contract) + step 6's explicit hand-read instruction + step 10 Gate B                                                           |
| `validateString`'s message rewritten (20 call sites, zero coverage today)                                           | ships-a-bug  | Step 2 test #6 + step 10 Gate C row 4                                                                                                                    |
| `rejectUnknownConfigKeys`'s `Unknown property` message rewritten (9 call sites, zero coverage)                      | ships-a-bug  | Step 2 test #9 + step 10 Gate C row 6                                                                                                                    |
| `requireConfigObject`'s message drifts during the step-9 merge                                                      | ships-a-bug  | Step 2 test #10 (both call-site families) + step 10 Gate C row 7                                                                                         |
| Raw `got ${value}` harmonised to `got ${describeType(value)}`, turning `got NaN` into `got number`                  | ships-a-bug  | Step 2 tests #2-#5 (all four tails) + step 7 and step 10 message-shape gate (`4` / `4`)                                                                  |
| Two `class ConfigError` declarations; `canHandle` silently stops firing and validation errors escape `loadConfig`   | ships-a-bug  | Step 3 formatter test (written before the move) + step 4 and step 10 Gate A, scoped to this worktree's `src/`                                            |
| `export type { ConfigError }` erased from emitted JS → runtime `ReferenceError`                                     | ships-a-bug  | §2.1 written prohibition; the plan adds no re-export anywhere, so the form has no place to appear                                                        |
| Step-3 test import never repointed → typecheck cannot go clean; "fixed" by adding a re-export shim to `config.ts`   | breaks-build | Step 5 repoints **three** files; step 4 verify expects exactly three `TS2459`; step 5 verify asserts `grep -n 'export .*ConfigError' config.ts` is empty |
| `npm run format` errors out with `No parser and no file path given`; step is skipped as environmental               | breaks-build | Every verify block uses `npm run format:rfmedia` or `npm run format -- <path>`                                                                           |
| Workspace-flag command run from inside the package → `No workspaces found`                                          | breaks-build | Every command is rooted at the worktree root and says so                                                                                                 |
| Orphaned `import { normalizeHttpUrl }` left in `config.ts` — compiles, passes 4310 tests                            | wastes-time  | Step 8's explicit hand-delete plus `grep -n "http-url" config.ts` must be empty                                                                          |
| Gate B reports 3 false failures from Prettier's signature re-wraps                                                  | wastes-time  | Step 10 Gate B uses the token normaliser; §2 states the three re-wraps are expected                                                                      |
| Gate B run against a `/tmp` snapshot → Prettier resolves no config, silently uses `printWidth: 80`                  | wastes-time  | §0.1 puts the snapshot at `<worktree>/.312-scratch/`, inside the repo but outside `src/`                                                                 |
| Gates verified in step 10 but formatting happens later, so committed bytes were never inspected                     | wastes-time  | `format:rfmedia` runs at the **end of every step**, before that step's verify                                                                            |
| Steps 6-9 executed against stale HEAD offsets, cutting into live code                                               | wastes-time  | Every edit in §3 is anchored on unique text; §2 carries the full block bodies; line numbers appear only as orientation                                   |
| `Edit` aborts on non-unique `old_string` at the six `requireConfigObject` call sites                                | wastes-time  | Step 9b uses a single whole-file `sed` substitution                                                                                                      |
| Post-rename Prettier reflow at the discovery-seed call misread as damage                                            | wastes-time  | Step 9e states the exactly-one expected hunk                                                                                                             |
| Literal "template should now be absent from config.ts" check gives a false reading                                  | wastes-time  | §1 records the two intentionally-surviving duplicates; steps 6/9 use the declaration-count gate instead                                                  |
| Stray one-line JSDoc left behind for `rejectUnknownConfigKeys` / `requirePolicyConfigObject`                        | cosmetic     | Correction C4/C5; step 6 and step 9c call both out; step 10's orphaned-comment eyeball                                                                   |
| Gate C mutation lands outside the asserted substring → silent no-op                                                 | wastes-time  | Step 10's Gate C table names the exact token to mutate                                                                                                   |
| ROADMAP.md left stale; counters wrong                                                                               | wastes-time  | Step 11                                                                                                                                                  |
| `gh pr create --label type:refactor` hard-fails                                                                     | wastes-time  | Step 13 names the three real labels                                                                                                                      |
| PR title double-numbered (`(#312) (#NNN)`) on squash merge                                                          | cosmetic     | Correction C23; step 13                                                                                                                                  |
| Design doc's commit disposition unstated; `docs/plans/` needs `docs(internal):` under squash-only merges            | wastes-time  | Step 12's three-commit split                                                                                                                             |
| PR `## Testing` claims commands that do not exist (issue's own plan cites a non-existent root `check:architecture`) | wastes-time  | §5's command list is the only one to paste; correction C16                                                                                               |
| Reviewer rejects the PR for skipping the enum helpers the issue's scope line names                                  | wastes-time  | §6 requires §3.4's verdict verbatim in the PR's `## Changes`                                                                                             |
| Reviewer asks for evidence that step 9 is safe and CI cannot produce it                                             | wastes-time  | Step 2 test #10 makes step 9 genuinely guarded; §6 records that step 9 reverts alone                                                                     |

Explicitly **accepted, not prevented**:

- **The `loadConfig` `logWarn("Config validation error in …")` half is unasserted anywhere**
  (correction C20). This plan does not touch `loadConfig`, and adding coverage is out of scope. The
  `continue` fall-through is covered by `config.test.ts:3543-3574`.
- **`validateDiskSpaceMargin`'s `NaN` gap** (`copy.diskSpaceMargin: .nan` is currently accepted). It
  stays in `config.ts` precisely so nobody harmonises it here. File as a follow-up bug.
- **No `config-validation.test.ts` unit layer.** Step 2's ten guards plus the 263 existing tests pin
  every moved message through the public API. A parallel unit layer is the churn #312 exists to
  avoid.

## 5. Final gate sequence

Run in this order, all from the worktree root, after step 12's cleanup. This is the CI-equivalent
set: `.github/workflows/rfmedia-cli.yml` runs `test:codegen:lidarr`, `codegen:lidarr:check`, the
`rf-common` build, `typecheck` (whose `pretypecheck` re-runs the codegen check, `check:architecture`,
and the 66 architecture tests, then `tsc --noEmit` **and** `tsc --noEmit -p benchmarks/tsconfig.json`),
`test:coverage`, and a separate `bench` job.

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-312-config-validation

# 1. formatting is clean (nothing left for lefthook to rewrite)
npm run format:rfmedia
npx --no -- prettier --check \
  packages/rfmedia-cli/src/lib/config-validation.ts \
  packages/rfmedia-cli/src/lib/config.ts \
  packages/rfmedia-cli/src/lib/error-formatters.ts \
  packages/rfmedia-cli/src/lib/error-formatters.test.ts \
  packages/rfmedia-cli/src/lib/config.test.ts
# -> All matched files use Prettier code style!

# 2. markdown
npx --no -- markdownlint-cli2 ROADMAP.md docs/roadmap-archive.md \
  "packages/rfmedia-cli/docs/plans/issue-312-config-validation/*.md"
# -> Summary: 0 error(s)

# 3. codegen contract (CI runs this; the design's gate list omits it)
npm run test:codegen:lidarr -w packages/rfmedia-cli
# -> node --test passes, exit 0

# 4. architecture gate, explicitly (also runs transitively inside pretypecheck)
npm run check:architecture -w packages/rfmedia-cli
# -> OK: Plex/Lidarr dependency direction and authenticated fetch ownership across 339 production files.

# 5. typecheck (pretypecheck: codegen check + arch check + 66 arch tests; then two tsc passes)
npm run typecheck -w packages/rfmedia-cli
# -> "# pass 66  # fail 0", then exit 0.  ~30 s wall.

# 6. full suite, with memory hygiene
umask 022 && env -u FORCE_COLOR npm run test:rfmedia
# -> Test Files  171 passed (171)
# -> Tests       4321 passed (4321)      [4310 baseline + 10 step-2 + 1 step-3]

# 7. coverage variant, exactly as CI runs it
umask 022 && env -u FORCE_COLOR npm run test:coverage -w packages/rfmedia-cli
# -> same 171 / 4321, exit 0 (no thresholds are configured)

# 8. benchmarks, exactly as the CI bench job runs them
RFMEDIA_BENCH_SCALES=10,100 npm run bench -w packages/rfmedia-cli
# -> exit 0

# 9. identity gate, scoped to this worktree
grep -rn "class ConfigError" --include="*.ts" \
  /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-312-config-validation/packages/rfmedia-cli/src
# -> exactly one line, in src/lib/config-validation.ts

# 10. no shim, no orphan, no stale name
grep -n 'export .*ConfigError' packages/rfmedia-cli/src/lib/config.ts        # -> nothing
grep -n 'http-url' packages/rfmedia-cli/src/lib/config.ts                    # -> nothing
grep -nE 'requireLidarrCascadeAnalysisObject|requirePolicyConfigObject' \
  packages/rfmedia-cli/src/lib/config.ts                                     # -> nothing
grep -c 'from "./config-validation.js"' packages/rfmedia-cli/src/lib/config.test.ts
                                                                             # -> 1 (identity guard intact)
grep -rn 'from "./config.js"' packages/rfmedia-cli/src/lib --include="*.ts" | grep -v '\.test\.ts:'
                                                                             # -> nothing

# 11. line delta
wc -l packages/rfmedia-cli/src/lib/config.ts packages/rfmedia-cli/src/lib/config-validation.ts
# -> config.ts ~5090 (from 5291); config-validation.ts ~205

# 12. only intended files changed
git status --porcelain
```

**No shell completion template change is required.** Evidence: `src/lib/shell-completions/bash.ts`,
`zsh.ts`, `fish.ts` and `index.ts` each return `0` for
`grep -c "lib/config\|\./config\.js\|ConfigError"`; the only `config` reference anywhere in that
directory is `templates.spec.ts:45`'s `vi.mock("../loaded-config.js", …)`, which targets
`loaded-config.ts` — a different module this change does not touch. `templates.spec.ts`'s
order-sensitive triple-shell equality assertion therefore cannot be perturbed. The
`CLAUDE.md` rule about updating all three shell templates applies to **new commands**; this change
adds no command, option, or completion candidate.

## 6. Deliverables checklist

### Code

- [ ] `packages/rfmedia-cli/src/lib/config-validation.ts` — new, ~205 lines, one import
      (`./http-url.js`), 12 exported symbols, module header carrying the four-clause admission rule
      and the `got ${value}` asymmetry note.
- [ ] `packages/rfmedia-cli/src/lib/config.ts` — 5291 → ~5090. Twelve declarations removed, one
      12-name value import added, `./http-url.js` import deleted, both `require*Object` helpers
      merged and their six call sites renamed.
- [ ] `packages/rfmedia-cli/src/lib/error-formatters.ts` — one import specifier changed.
- [ ] No re-export shim in `config.ts`. No `import type` / `export type` for `ConfigError` anywhere.

### Tests

- [ ] `config.test.ts` — import split (`ConfigError` from `./config-validation.js`; four names stay
      on `./config.js`) **plus** ten new drift-guard tests. 263 → 273.
- [ ] `error-formatters.test.ts` — one `ConfigError` import (repointed) and one new test. 12 → 13.
- [ ] `config-init-merge.test.ts` — **unchanged** (10 tests, imports only
      `buildConfigTemplate`/`mergeConfigs`/`writeConfigTemplate`).
- [ ] `cli.test.ts` and the six `vi.mock("../lib/config.js")` action tests — **unchanged**.
- [ ] No `config-validation.test.ts`.
- [ ] Full suite: 4310 → **4321**; four-file loop: 286 → **297**.

### Docs

- [ ] `packages/rfmedia-cli/docs/plans/issue-312-config-validation/design.md` and `plan.md` shipped,
      Prettier-clean, markdownlint-clean, in a `docs(internal):` interior commit.
- [ ] **No `CHANGELOG.md` entry.** Zero user-facing change; matches the `0640943f`/#309 chore
      precedent. State this in the PR body so the decision is visible rather than guessed.
- [ ] No README, no `docs/features/` change — nothing user-facing moved.

### ROADMAP

- [ ] `ROADMAP.md` — six #312 references removed/updated, `Last updated` refreshed, open-issue
      counter `85 (rfapps 36 · rfmedia 49)` → `84 (rfapps 36 · rfmedia 48)`, low-priority section
      count `(28)` → `(27)`.
- [ ] `docs/roadmap-archive.md` — new issue→PR row for #312.
- [ ] Both in a `docs(roadmap):` interior commit.

### Commits

- [ ] `refactor(rfmedia): extract config validation primitives into config-validation.ts`
- [ ] `docs(internal): record issue-312 config-validation design and plan`
- [ ] `docs(roadmap): record config validation primitive extraction`

The main commit body should, in the house style of `0640943f`: enumerate the twelve moved symbols;
report the delta (5291 → ~5090); state each refusal with its failed admission-rule clause
(`validateRatingPercent`, `validatePageSize`, `validateConvertFormat`, `validateRangeString`,
`validateDiskSpaceMargin`, the redaction trio, the eight Lidarr preset helpers); and note "test suite
unmodified apart from a 3-line import repoint, ten drift-guard assertions, and one new formatter
test".

### PR body — required sections

- **`## Summary`** — zero user-facing change; extracts `ConfigError` plus eleven assertion primitives
  out of a 5291-line module and establishes a four-clause admission rule for future helpers.
- **`## Changes`** — the file table, **plus §3.4's verdict verbatim**: "the enumeration in the scope
  line was a candidate list, not a contract; the governing completion check is 'primitives live
  outside config.ts'", followed by the four-clause admission rule from §2.3 and the per-refusal
  clause list. Three design reviewers flagged the missing enum helpers; a reviewer diffing the
  issue's scope line against this PR must find the reasoning here, not only in the commit body.
- **`## Testing`** — paste §5's commands 3-8 with real pass/fail output. Do **not** copy the issue's
  literal verification block: its `npm run check:architecture` has no root script (correction C16).
- **`## Related Issues`** — `Closes #312`.
- **`## Breaking Changes`** — none.
- **`## Risk and Rollback`** — name the commit that reverts the `requireConfigObject` merge alone;
  state that steps 6-9 revert to the step-5 state, which is itself coherent, green, and
  independently mergeable; no data migration, no config format change, no persisted state.
- **`## Checklist`** — as templated.

### Issue completion checks

- [ ] Primitives live outside `config.ts` — the governing acceptance criterion.
- [ ] `ConfigError` has a single canonical export (Gate A).
- [ ] Risk (a) — path-aware message drift: ten new message guards + Gate C's seven re-anchored
      mutations + the `4`/`4` message-shape gate.
- [ ] Risk (b) — import cycle: `config-validation.ts`'s transitive closure is exactly
      `{ http-url.ts }`, and `http-url.ts` has zero imports. A cycle is unconstructible.
- [ ] Risk (c) — mechanical test churn: three repointed import statements, eleven added tests, zero
      test rewrites.
- [ ] Follow-ups filed: `config-lidarr-presets.ts` extraction, `config-redaction.ts` extraction, the
      23 inline `Expected object for …` throws, and the `validateDiskSpaceMargin` `NaN` gap.
