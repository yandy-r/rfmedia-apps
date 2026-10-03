# Design: Hierarchical Service Tagging (`--tag` selector) — issue #63

**Issue:** [#63](https://github.com/yandy-r/rfmedia-apps/issues/63) — `[rfapps-cli] Hierarchical Service Tagging`
**Package:** `packages/rfapps-cli`
**Base:** `master` @ `c54b647b`
**PR title (changelog line, verbatim):** `feat(rfapps): add hierarchical tag selector for service targeting (#63)`

---

## 1. Decision summary

We are adding a **hierarchical tag selector** to rfapps-cli. Tags live in the **layered YAML config** as a new **optional, service-keyed** `tags.mapping: Record<string, string[]>` section — the same file and the same shape as the existing `groups`, `profiles.mapping`, and `sidecars.mapping`. Nothing is written to `compose.yml`, nothing is written to the SQLite state database, and v1 writes no configuration file at all: tags are hand-authored in a reviewed PR, and `rfapps tag suggest` generates a paste-ready YAML fragment to remove the tedium of doing that for 45 services. A single repeatable `--tag <pattern>` flag narrows the existing selection by intersection: `RESULT = materialize(NAMES ∪ GROUPS) ∩ TAGS`, resolved inside the one existing chokepoint (`resolveServicesWithInteractive`) so that all 20 resolver-backed command paths inherit it in one edit. The load-bearing safety property is that when `--tag` is present the result is **always an explicit, non-empty service list** — a pattern that matches nothing throws `TagSelectorEmptyError` (exit 2) rather than collapsing into the overloaded `services: []` sentinel that means "operate on the whole Compose project."

---

## 2. Goals / Non-goals

### Goals

1. Hierarchical, glob-matchable tags with unambiguous, documented semantics.
2. A `--tag` selector on every command that already accepts `-g/--group`, plus `status`.
3. A read-only `rfapps tag` command group for inspecting the taxonomy (`list`, `show`, `suggest`).
4. Auto-inference (`tag suggest`) so the initial taxonomy is generated, not hand-typed 45 times.
5. Pay down the four-way duplicated "has a targeting flag" predicate while adding a fifth axis to it.
6. Zero behavior change when `--tag` is absent — structurally, not by testing.

### Non-goals

- **No tag mutation command in v1.** The issue's literal `rfapps tag -s traefik infrastructure/core/networking` is deferred; see §10 and §13.
- **No compose.yml writes, ever.** §5.3.
- **No state-DB storage.** §5.3.
- **No MCP surface.** §9.
- **Not issue #62 (Smart Service Groups).** This is the boundary that matters, so it is explicit:

|                     | #63 (this design)                    | #62 (Smart Service Groups)                         |
| ------------------- | ------------------------------------ | -------------------------------------------------- |
| Data source         | static, authored/derived from config | dynamic, observed at runtime                       |
| Storage             | `rfapps.config.yaml` `tags:`         | criteria definitions, `~/.rfapps/smart-groups.yml` |
| Evaluation          | pure, offline, zero Docker calls     | requires `docker stats` / `inspect`                |
| Flag                | `--tag <pattern>`                    | `--smart-group <name>`                             |
| Role in the algebra | a **narrowing** term                 | a term whose direction #62 decides                 |

**#63 MUST NOT** introduce runtime criteria, health-based selection, `docker stats`, dynamic evaluation, or a second config file. `tag suggest` reads config and (optionally) `compose.yml` — never runtime state.

**#63's gift to #62:** `SelectorFlags` + `hasExplicitSelector()` in the new `src/lib/selector.ts` is the single extension point. #62 becomes: add `smartGroup?: string` to `SelectorFlags` and `ServiceTargetOptions`, add one clause to `hasExplicitSelector`, implement the criteria evaluator, and decide widening-vs-narrowing. Everything else — the four unified predicates, the empty-selector error, sidecar/profile plumbing, the `--all` conflict check — is already done. **#63 makes #62 smaller; it does not swallow it.** `ROADMAP.md` records this.

---

## 3. Tag grammar and semantics

This section is normative. Ambiguity here is the feature's main failure mode.

### 3.1 Tag path grammar

```
tag      := segment ( "/" segment ){0,7}          # 1..8 segments
segment  := [a-z0-9] ( [a-z0-9._-]* [a-z0-9] )?   # starts/ends alphanumeric
```

Limits: `TAG_MAX_DEPTH = 8`, `TAG_MAX_SEGMENT_LENGTH = 40`, `TAG_MAX_LENGTH = 128`.

### 3.2 Normalization (`normalizeTag`)

1. Trim surrounding whitespace.
2. Lowercase (`toLowerCase()`). Tags are **case-insensitive**; canonical form is lowercase.
3. Strip **at most one** leading `/` and **at most one** trailing `/`.
4. Split on `/`. Any empty segment (i.e. `a//b`, or a doubled leading/trailing slash) → **throw**.
5. Validate each segment against the charset regex → **throw**.
6. Validate depth ≤ 8, segment length ≤ 40, total length ≤ 128 → **throw**.
7. Return `segments.join("/")`.

Steps 2–3 are canonicalization, not error-hiding: `Media/Streaming/` and `media/streaming` denote the same concept, and silently creating two parallel hierarchies is worse than folding them. Step 4 rejects `a//b` because a doubled slash has no defensible canonical reading.

Normalization is idempotent.

Throw sites:

- CLI input (a `--tag` literal segment) → `InvalidArgumentError("--tag", input, reason)` → exit 2.
- Config input (`tags.mapping`) → `ConfigValidationError("tags.mapping", source, reason)` at `buildTagIndex()` time — fail fast at the boundary.

Case-folding of config input additionally produces a `ValidationWarning`, so `rfapps validate` reports `Tag 'Media/Streaming' for service 'plex' was normalized to 'media/streaming'`.

### 3.3 Ancestor closure — the one special rule

> A service tagged `a/b/c` **implicitly carries** `a/b` and `a`.

```ts
tagAncestors("a/b/c") === ["a", "a/b", "a/b/c"];
tagAncestors("a") === ["a"];
```

A service's **effective tag set** is the union over its declared tags of that tag and every proper prefix:

```
E(s) = ⋃_{t ∈ D(s)} tagAncestors(t)
```

**All matching is against `E(s)`, never `D(s)`.** This single rule is what makes hierarchy mean anything (it is the DigiKam model #63 cites), and it collapses all prefix logic into set membership so the matcher is pure pattern-vs-tag with no special cases. Without it, `--tag infrastructure` matches nothing when everything is tagged at depth 3 — a far worse and far more common trap than any surprise closure introduces.

### 3.4 Pattern grammar

```
pattern  := [ "!" ] element ( "/" element ){0,7}
element  := segment | "*" | "**"
```

| Token       | Meaning                                                      |
| ----------- | ------------------------------------------------------------ |
| literal     | matches that exact segment                                   |
| `*`         | matches **exactly one** segment. Never crosses `/`.          |
| `**`        | matches **zero or more** segments. Crosses `/`.              |
| leading `!` | negates the whole pattern (contributes to the exclusion set) |

**Wildcards occupy a whole element.** `net*`, `*working`, `a**b`, `infra?tructure` are rejected with `InvalidArgumentError`. This is load-bearing: it makes matching a pure segment-array comparison, permanently kills the "is `*` a character class or a segment class" ambiguity, and removes any argument for a `picomatch`/`minimatch` dependency (their `*` crosses `/`, and they carry brace expansion, character classes, and dotfile rules this grammar forbids).

Multiple `**` per pattern are allowed (`a/**/b/**/c`).

**Trailing `/*` is REJECTED** with `InvalidArgumentError`. See §3.6 for the reasoning — this is a deliberate divergence from the top-scoring design, adopted from a judge's salvage note.

### 3.5 The matcher

Patterns are anchored at both ends: the pattern must consume the entire tag path.

```
M[i][j] = "P[i..] matches T[j..]"

M[|P|][|T|]   = true
M[|P|][j<|T|] = false

P[i] = "**"      -> M[i][j] = M[i+1][j] || (j < |T| && M[i][j+1])
P[i] = "*"       -> M[i][j] = j < |T| && M[i+1][j+1]
P[i] = literal L -> M[i][j] = j < |T| && T[j] === L && M[i+1][j+1]
```

```
tagMatches(P, t)     = M[0][0]  over P.segments and t.split("/")
serviceMatches(P, s) = ∃ t ∈ E(s) : tagMatches(P, t)
```

`|P| ≤ 8` and `|T| ≤ 8`, so the DP is at most 81 cells — no backtracking pathology, no memoization needed.

**Implementation note (mandatory).** `packages/rfapps-cli/tsconfig.json` sets `noUncheckedIndexedAccess: true`. A naive `cur[j] = prev[j] || cur[j-1]` produces `TS2322: Type 'boolean | undefined' is not assignable to type 'boolean'`. Write the DP with explicit `?? false` coalescing or with local `const` bindings, and typecheck it before committing.

### 3.6 Pattern → matches table (normative)

Fixture (used verbatim in `tag-pattern.spec.ts`):

```yaml
tags:
  mapping:
    traefik: [infrastructure/core/networking]
    homarr: [infrastructure]
    plex: [media/streaming, hardware/gpu]
    sabnzbd: [downloads/usenet]
```

Effective sets:

```
E(traefik) = { infrastructure, infrastructure/core, infrastructure/core/networking }
E(homarr)  = { infrastructure }
E(plex)    = { hardware, hardware/gpu, media, media/streaming }
E(sabnzbd) = { downloads, downloads/usenet }
```

| Pattern                                | Matches                        | Does NOT match           | Reading                                                                                |
| -------------------------------------- | ------------------------------ | ------------------------ | -------------------------------------------------------------------------------------- |
| `infrastructure`                       | traefik, homarr                | plex, sabnzbd            | **bare segment = the whole subtree, inclusive**                                        |
| `infrastructure/**`                    | traefik, homarr                | plex, sabnzbd            | identical to bare `infrastructure` (`**` matches zero segments)                        |
| `infrastructure/*`                     | —                              | —                        | **REJECTED at parse time** (§3.4). `InvalidArgumentError`, suggesting `infrastructure` |
| `infrastructure/core`                  | traefik                        | homarr, plex, sabnzbd    | exact ancestor match                                                                   |
| `infrastructure/core/networking`       | traefik                        | homarr, plex, sabnzbd    | exact declared tag                                                                     |
| `infrastructure/core/**`               | traefik                        | homarr, plex, sabnzbd    | subtree below an ancestor                                                              |
| `*/core/**`                            | traefik                        | homarr, plex, sabnzbd    | interior single-segment wildcard                                                       |
| `**/networking`                        | traefik                        | homarr, plex, sabnzbd    | leaf-anchored, any depth                                                               |
| `*`                                    | traefik, homarr, plex, sabnzbd | —                        | every service with any depth-1 effective tag                                           |
| `**`                                   | traefik, homarr, plex, sabnzbd | —                        | every **tagged** service                                                               |
| `media`                                | plex                           | traefik, homarr, sabnzbd |                                                                                        |
| `hardware/gpu`                         | plex                           | traefik, homarr, sabnzbd | a multi-tag service matched on its **second** tag                                      |
| `MEDIA/Streaming`                      | plex                           | —                        | **case-insensitive** — normalizes to `media/streaming`                                 |
| `!media/**`                            | traefik, homarr, sabnzbd       | plex                     | negation                                                                               |
| `media/**,hardware/**`                 | plex                           | traefik, homarr, sabnzbd | **OR** within one `--tag` flag                                                         |
| `--tag "media/**" --tag "hardware/**"` | plex                           | traefik, homarr, sabnzbd | **AND** across `--tag` flags                                                           |
| `typoo/**`                             | —                              | —                        | **empty ⇒ `TagSelectorEmptyError`, exit 2** (never `[]`)                               |
| any pattern, service with no tags      | —                              | that service             | an untagged service matches nothing, including `**`                                    |

**Derived identity, to be stated in the docs:** `X ≡ X/**`. Both denote the X subtree including X itself. Because trailing `/*` is rejected, there is no third, subtly-different form to confuse.

### 3.7 Why trailing `/*` is rejected

Under ancestor closure, `X/*` would mean "the X subtree, _excluding_ services whose only X-tag is the depth-1 `X`." That is not "one level down" — it is a strict subset of `X` with a non-obvious exclusion rule, inverting every filesystem-glob intuition an operator brings. `X/*` has no legitimate use case that `X` does not serve better, and a judge correctly identified it as "a trap that exists solely to surprise."

Rejecting it costs one validation branch and eliminates the surprise entirely. The error message names the fix:

```
Error: Invalid value 'infrastructure/*' for --tag: trailing '/*' is not supported

Suggestions:
  Use 'infrastructure' to select the whole subtree
  Use 'infrastructure/**' for the same thing, written explicitly
  Run with --debug for more details
```

Interior `*` (`*/core/**`, `media/*/tv`) remains fully supported — only the _trailing_ position is rejected, because only there does closure make it a trap.

**Consequence for issue #63's literal example:** `rfapps status --tag "infrastructure/*"` from the issue text becomes `rfapps status --tag infrastructure`. This is documented in `## Limitations` and in the error message itself, so the issue's example fails loudly with the correct replacement rather than silently doing something surprising.

### 3.8 Negation semantics

Within one `--tag` flag:

```
INC_k = ⋃ { s : serviceMatches(p, s) } over positive patterns p in flag k
      = U                                if flag k contains ONLY negations
EXC_k = ⋃ { s : serviceMatches(p, s) } over negated patterns !p in flag k
T_k   = INC_k \ EXC_k
```

Note the consequence, which is documented: `--tag "!media/**"` selects **untagged services too**, because `E(s) = ∅` makes every positive pattern false but also makes every negation vacuously non-excluding. It is _not_ the complement of `--tag "**"`. If you want "tagged, but not media," write `--tag "**" --tag "!media/**"`.

### 3.9 Fuzzy suggestions

`findClosestMatch` (`lib/fuzzy-match.ts:52-74`) is path-unaware: `computeSimilarity("networking", "infrastructure/core/networking") ≈ 0.34`, below its `minScore = 0.4` default. **Do not change that default** — `fuzzy-match.spec.ts` pins it and service-name suggestions depend on it.

`findClosestTag(pattern, knownTags)` in `tag-index.ts`:

1. Extract the pattern's last literal segment (skip `*`/`**`/`!`).
2. For each known tag, compute `max(computeSimilarity(lastLiteral, seg))` over that tag's segments.
3. Compute `computeSimilarity(fullPattern, fullTag)`.
4. Take the max of (2) and (3); return the best above `0.5`.

---

## 4. Data model

### 4.1 `src/types/tags.ts` (new, ~110 lines)

```ts
/** Machine-output schema version for every tag surface. */
export const TAGS_SCHEMA_VERSION = "tags.v1" as const;

export const TAG_MAX_DEPTH = 8;
export const TAG_MAX_SEGMENT_LENGTH = 40;
export const TAG_MAX_LENGTH = 128;

/**
 * A normalized, validated hierarchical tag path: lowercase, slash-separated,
 * no leading/trailing slash, no empty segments.
 * Nominal type — only normalizeTag() may mint one.
 */
export type TagPath = string & { readonly __brand: "TagPath" };

/** The `tags:` section of rfapps.config.yaml. Service-keyed, mirrors profiles.mapping. */
export interface TagConfig {
  /** service name -> declared tag paths, as authored (pre-normalization). */
  readonly mapping?: Readonly<Record<string, readonly string[]>>;
}

export type TagPatternElement =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "single" } // *  — exactly one segment
  | { readonly kind: "deep" }; // ** — zero or more segments

export interface TagPattern {
  readonly source: string;
  readonly negated: boolean;
  readonly elements: readonly TagPatternElement[];
}

/** One `--tag` flag occurrence: comma-separated patterns within it OR together. */
export interface TagTerm {
  readonly source: string;
  readonly include: readonly TagPattern[];
  readonly exclude: readonly TagPattern[];
}

/** Immutable, memoized projection of config.tags for one RfappsConfig. */
export interface TagIndex {
  /** service -> declared (normalized) tags */
  readonly declared: ReadonlyMap<string, readonly TagPath[]>;
  /** service -> ancestor-closed effective tag set */
  readonly effective: ReadonlyMap<string, ReadonlySet<TagPath>>;
  /** tag -> services carrying it effectively */
  readonly byTag: ReadonlyMap<TagPath, readonly string[]>;
  /** every effective tag, sorted */
  readonly allTags: readonly TagPath[];
  /** only tags an operator actually wrote (no derived ancestors) */
  readonly declaredTags: ReadonlySet<TagPath>;
  /** services present in tags.mapping but absent from compose.yml */
  readonly unresolvedServices: readonly string[];
  /** the config file path the winning `tags:` block came from */
  readonly source: string;
}

export type TagInferenceRuleId =
  | "tag-infer-profile"
  | "tag-infer-group"
  | "tag-infer-arr"
  | "tag-infer-database"
  | "tag-infer-cache"
  | "tag-infer-ingress"
  | "tag-infer-tailnet";

export type TagInferenceConfidence = "high" | "medium";

export interface TagProposal {
  readonly service: string;
  readonly tags: readonly TagPath[];
  readonly rules: readonly TagInferenceRuleId[];
  readonly confidence: TagInferenceConfidence;
  /** true when the service already carries this tag (or an ancestor) */
  readonly alreadyPresent: boolean;
}

export interface TagSuggestResult {
  readonly schemaVersion: typeof TAGS_SCHEMA_VERSION;
  readonly proposals: readonly TagProposal[];
  readonly unresolved: readonly string[];
  readonly skippedRules: readonly TagInferenceRuleId[];
  readonly degraded: boolean;
  readonly fragment: string;
  readonly writtenTo?: string;
}

export interface TagListEntry {
  readonly tag: TagPath;
  readonly depth: number;
  readonly declared: boolean;
  readonly services: readonly string[];
  readonly serviceCount: number;
}

export interface TagListResult {
  readonly schemaVersion: typeof TAGS_SCHEMA_VERSION;
  readonly tags: readonly TagListEntry[];
  readonly totalTags: number;
  readonly totalServices: number;
  readonly untaggedServices: readonly string[];
  readonly unresolvedServices: readonly string[];
  /** absolute path of the config layer that won the `tags:` block */
  readonly source: string;
}

export interface TagShowEntry {
  readonly service: string;
  readonly declaredTags: readonly TagPath[];
  readonly effectiveTags: readonly TagPath[];
}

export interface TagShowResult {
  readonly schemaVersion: typeof TAGS_SCHEMA_VERSION;
  readonly services: readonly TagShowEntry[];
}
```

### 4.2 `src/lib/selector.ts` (new, ~140 lines) — the unification

```ts
import type { TagIndex, TagTerm } from "../types/tags.js";

/**
 * The flags that constitute an explicit target.
 *
 * `services` accepts BOTH shapes on purpose: Commander declares `--services <names>`
 * with no argParser, so raw `actionCommand.opts()` yields a comma-joined STRING,
 * while typed option objects carry `string[]`. Two of the six call sites read raw
 * Commander opts (cli.ts:234, commands/backup.ts), so a `string[]`-only signature
 * would either not typecheck or silently coerce.
 */
export interface SelectorFlags {
  readonly service?: string;
  readonly services?: string | readonly string[];
  readonly group?: string;
  readonly tag?: readonly string[];
}

/** Normalizes the dual-shape `services` field. Empty string / empty array => absent. */
export function hasServicesSelector(services: string | readonly string[] | undefined): boolean;

/**
 * THE predicate. Replaces four duplicated inline copies plus two selectorFlags arrays.
 * Adding a new selector axis (#62) means editing this function and nothing else.
 */
export function hasExplicitSelector(flags: SelectorFlags): boolean;

/** e.g. ["--group", "--tag"] — for --all conflicts and error messages. */
export function explicitSelectorFlagNames(flags: SelectorFlags): string[];

/** e.g. `--group arr-stack, --tag "media/**"` — for InvalidArgumentError reasons. */
export function describeSelector(flags: SelectorFlags): string;

/**
 * `kind: "absent"` is the STRUCTURAL guarantee of backward compatibility.
 * Callers MUST short-circuit to the legacy path on it.
 */
export type TagAxis =
  | { readonly kind: "absent" }
  | {
      readonly kind: "present";
      readonly terms: readonly TagTerm[];
      readonly matched: ReadonlySet<string>;
    };

/**
 * Computes the tag axis over `universe` (compose service names).
 * Throws InvalidArgumentError on a malformed pattern. Never throws on an empty
 * result — that decision belongs to the caller (query vs. select).
 */
export function applyTagAxis(
  tagFlags: readonly string[] | undefined,
  index: TagIndex,
  universe: readonly string[],
): TagAxis;
```

**Backward-compatibility note on `hasExplicitSelector`.** `cli.ts:262` currently treats `--services ""` as a target (`!== undefined`). `hasServicesSelector` returns `false` for `""`. This is a deliberate, documented behavior change: `--services ""` splits to zero service names, so treating it as a target is a latent bug (it currently suppresses the deploy `--staged` preflight for a selector that resolves to nothing). It is called out in `## Limitations` and pinned by a test.

### 4.3 `src/types/options.ts` — modified

```ts
export interface ServiceTargetOptions {
  service?: string;
  services?: string[];
  group?: string;
  /**
   * Narrow the target set by hierarchical tag pattern.
   * One array element per `--tag` occurrence; within an element, commas OR.
   * Across elements, AND. `undefined` => resolution is structurally unchanged
   * from pre-#63 behavior. NEVER defaulted to `[]` — see the Commander note in §7.4.
   */
  tag?: string[];
  noSidecars: boolean;
}
```

This one edit reaches `PullOptions`, `BuildOptions`, `DeployOptions`, `StopOptions`, `RebuildOptions`, `DeleteOptions`, `PruneOptions`, `StatusOptions`, `HealthOptions` (`types/options.ts:74-177`), plus `AuditOptions` (`types/audit.ts:69`), `DoctorOptions` (`types/doctor.ts:65`), and `HardenOptions` (`types/hardening.ts:262`).

**Type fan-out vs. flag declaration.** Twelve option interfaces will carry `tag?`, but only the commands listed in §7.2 declare the flag. This is the same asymmetry that already exists for `--profile` (read by `stop`/`delete`/`prune` actions, not declared on those commands). To stop the type fan-out from silently arming an undeclared command, all six selector sites are updated **in code, not comments** (§7.5) — so a future contributor who adds `.option("--tag", ...)` to `harden` gets correct behavior for free.

### 4.4 `src/types/config.ts` — modified

```ts
export interface RfappsConfig {
  // ... existing fields ...
  lint?: LintConfig;
  scan?: ScanConfig;
  harden?: HardenConfig;
  tags?: TagConfig; // NEW
}

export interface PartialRfappsConfig {
  // ... existing fields ...
  tags: Partial<TagConfig>; // NEW
}
```

### 4.5 `src/lib/errors.ts` — one new class

```ts
export class TagSelectorEmptyError extends Error {
  readonly patterns: string[];
  readonly baseSelectors: string[];
  readonly knownTags: string[];
  readonly suggestion?: string;

  constructor(patterns: string[], baseSelectors: string[], knownTags: string[], suggestion?: string) {
    super(`Tag selector matched no services: ${patterns.join(", ")}`);
    this.name = "TagSelectorEmptyError";
    this.patterns = patterns;
    this.baseSelectors = baseSelectors;
    this.knownTags = knownTags;
    if (suggestion !== undefined) this.suggestion = suggestion;
  }
}
```

Dependency-free, `readonly` context fields, string-literal `this.name` — matching the 12 existing classes. Auto-exported via `export * from "./errors.js"` in `lib/index.ts`.

**Only one new class.** Tag _syntax_ errors reuse `InvalidArgumentError("--tag", value, reason, validValues)`; config-side syntax errors reuse `ConfigValidationError`. Only the empty-selector case needs a bespoke class, because it needs a segment-aware fuzzy suggestion and a distinctly-worded message. `TagSelectorEmptyError extends Error` (not `InvalidArgumentError`), and all 15 existing formatters are `instanceof`-exact with no catch-all, so **registration order is not load-bearing** — the formatter may be appended anywhere inside `registerRfappsErrorFormatters()`.

---

## 5. Storage

### 5.1 On-disk format

An **optional** top-level `tags:` section in the layered YAML config, holding one service-keyed map:

```yaml
# rfapps.config.yaml (or any higher config layer)

# Hierarchical service tags. Optional.
# Service-keyed, mirroring profiles.mapping and sidecars.mapping.
# Store LEAF paths only — ancestors are derived automatically, so a service
# tagged `infrastructure/core/networking` also matches `infrastructure/core`
# and `infrastructure`.
tags:
  mapping:
    traefik:
      - infrastructure/core/networking
      - network/ingress
    authentik-server:
      - infrastructure/core/identity
    plex:
      - media/streaming
      - hardware/gpu
    sonarr:
      - media/automation/tv
    radarr:
      - media/automation/movies
    sabnzbd:
      - media/downloads/usenet
    immich-server:
      - photos/library
```

Service-keyed (not tag-keyed) because: it matches the two existing service-keyed maps, so `getTagsForService` sits naturally beside `getProfileForService` (`lib/services.ts:53-55`); `rfapps tag show -s traefik` is O(1) rather than an O(n) scan; and a future v2 writer becomes a single-node `setIn(["tags","mapping",service], seq)` edit.

Only leaf paths are stored; ancestors are derived (§3.3), so the flat map is lossless for hierarchy.

### 5.2 Config plumbing (exactly 4 edits)

Following the documented recipe (`packages/rfapps-cli/CLAUDE.md:1040-1089`), modelled byte-for-byte on the `harden:` section:

1. `src/types/tags.ts` — new `TagConfig` interface.
2. `src/types/config.ts:153` — `tags?: TagConfig;` on `RfappsConfig`.
3. `src/types/config.ts:173` — `tags: Partial<TagConfig>;` on `PartialRfappsConfig`.
4. `src/lib/config.ts` — one branch in each of `mergeConfig` and `partialToFull`:

```ts
// mergeConfig (:120-178), mirroring the lint/scan/harden branches:
tags: { mapping: override.tags?.mapping ?? base.tags?.mapping ?? {} },

// partialToFull (:184-271):
tags: { mapping: partial.tags?.mapping ?? {} },
```

**`tags` MUST NOT join the four required-field throws** at `config.ts:186-209` (`sidecars.mapping`, `groups`, `profiles.mapping`, `profiles.validProfiles`). Adding a fifth breaks every existing config file and the fixture at `src/testing/cli-harness.ts:54`.

**No `RFAPPS_TAGS` env var.** `loadConfigFromEnv` (`config.ts:320-406`) handles 9 scalars and has no map/array precedent. Do not invent one.

**No entry in `generateSampleConfig`** (`config.ts:604-646`) — it already omits `groups`, `lint`, `scan`, and `harden`, so omitting `tags` is consistent, not an oversight. A commented-out template block is added to the shipped `rfapps.config.yaml` instead, mirroring how `scan:` and `harden:` are documented-but-inactive.

### 5.3 Rejected storage media — with evidence

**SQLite state DB — architecturally disqualified.**
`carryOverState` (`src/lib/state-rebuild.ts:642-673`) is the salvage path for `rfapps state rebuild --rewrite`, and it carries exactly two tables:

```ts
const carriedIds = carryDeployments(source, target, counts);   // :655
if (tables.has("generations")) { carryGenerations(...); }      // :656-658
```

A `service_tags` table would exist-but-empty in the fresh replacement (because `initializeDatabase` execs `schema.sql`), and the replacement is `rename()`d over the original. A routine recovery operation would silently destroy the operator's entire taxonomy with no warning and no re-derivation path. It would also falsify the package's own **State Database Invariant** (`CLAUDE.md:419-429`): the DB is _derived and re-derivable_, and authored tags are reconstructible from neither Docker runtime nor compose. Secondary disqualifiers: DB path resolution is split-brain (8 call sites use bare `initializeDatabase()`, 6 use `getStateDbPath(config)`); `state.enabled` is an advertised off-switch; and `~/.config/rfapps/state.db` is machine-local, un-reviewable, and not in git.

**Compose labels — operationally disqualified.**
`resolvedServiceConfigFingerprint` (`lib/plan-generator.ts:90-94`) sha256s the entire canonicalized resolved compose service object. Labels are in that object. Writing one tag label:

| Consumer                   | Anchor                         | Effect                                                                                 |
| -------------------------- | ------------------------------ | -------------------------------------------------------------------------------------- |
| Saved plans                | `plan-storage.ts:1548-1561`    | **every** saved plan invalidated (`"Compose file has changed since plan was created"`) |
| Pre-deploy revalidation    | `deploy-validation.ts:759-770` | `VALIDATION_INPUT_CHANGED` → **deploy aborts**                                         |
| Plan-intelligence baseline | `plan-intelligence.ts:265-266` | every tagged service flagged changed                                                   |
| Reconcile equality         | `actions/reconcile.ts:413`     | reconcile sees divergence                                                              |
| Backup manifest            | `backup-planner.ts:631`        | prior manifests stop matching                                                          |

Plus a new silent-downtime bug class: Compose's `com.docker.compose.config-hash` includes labels (the repo's own `docs/features/traefik-reverse-proxy.md:427` states services must be recreated to apply label changes), while `ServiceChange` (`src/types/plan.ts:152-169`) has no labels field and `src/lib/drift.ts` never reads labels. `rfapps plan` would report `unchanged` while the next `deploy` recreates plex/jellyfin/immich.

And it was **measured**: `parseDocument(compose.yml).toString({ lineWidth: 0, flowCollectionPadding: false })` already differs from source (`lineDelta -6`, one hunk at the `authentik-server` healthcheck flow sequence, `compose.yml:197-210`). So `detectReformat().wouldReformat === true` **today**, and any harden-modelled writer refuses without `--allow-reformat` on every edit. Separately, harden's applier is not reusable: `applyPatch` (`hardening.ts:322-329`) refuses any patch key containing `.`, so `labels.rfapps.tags` is unreachable, and a `set` on bare `labels` would destroy the Traefik/docktail labels on the 27 services that carry them.

Note that **all of the above is a property of the medium, not of the agent.** An operator hand-editing compose labels triggers the same plan invalidation and the same silent recreate. That is why compose labels are rejected as the _home_ for tags, not merely as a _write target_.

**Writing config in v1 — deferred, not disqualified.**
`parseDocument` round-trips this repo's `rfapps.config.yaml` byte-identically (measured), so a comment-preserving writer is technically feasible — unlike compose.yml. But it is deferred: it is a net-new read-modify-write path in a package that has none, it needs layer discovery that `loadConfig` does not currently expose, its round-trip stability is file-dependent (measured stable here, but flow sequences longer than the default `lineWidth` and non-2-space indentation both perturb it), and `rfapps.config.yaml` is covered by `npm run format:check`, so a writer must also produce prettier-clean output. `tag suggest`'s paste-ready fragment delivers the authoring value at a fraction of the risk. See §13 for the forward design.

### 5.4 Layering semantics — replace, not merge (and why that is a real cost)

`mergeConfig` (`config.ts:120-178`) is one level deep; every collection is whole-value replacement (`groups` at `:128`, `lint.ignore` at `:161`, `scan.ignore` at `:166`, `harden.ignore` at `:172`). `tags.mapping` follows the same rule: a `tags:` block in `.rfapps.yaml` **fully shadows** `rfapps.config.yaml`'s.

This is a genuine footgun for a 45-entry map — adding one personal tag in a local override silently discards the whole fleet taxonomy — and it is worse for tags than for `groups` because tags are the section an operator would most naturally extend incrementally. We keep the consistent semantics anyway (introducing the function's first deep-merge for exactly one section is its own inconsistency, and it would make the `tags:` merge rule unpredictable relative to every neighbouring section), and mitigate three ways:

1. `validateTagLayerOwnership` emits a `ValidationWarning` whenever more than one config layer defines `tags:`, surfaced by `rfapps validate` and by `validateConfigAgainstCompose`.
2. `rfapps tag list` and `TagListResult.source` report the absolute path of the winning layer, so shadowing is diagnosable in one command.
3. It is documented explicitly in `docs/features/rfapps-configuration.md` and in the operator doc's `## Limitations`.

Per-service deep merge is named as the most likely v2 reversal.

---

## 6. CLI surface

### 6.1 The `rfapps tag` command group (read-only)

```text
rfapps tag list    [-f <compose>] [-e <env-file>] [-p <profile>] [--tree] [--json]
rfapps tag show    -s <service> | --services <names>   [-f] [-e] [-p] [--json]
rfapps tag suggest [-s <service>] [--services <names>] [-g <group>]
                   [--rule <ids>] [--list-rules] [--include-tagged]
                   [-o|--out <path>] [-f] [-e] [-p] [--json]
```

Registered via `registerTagCommand(program, dependencies = defaultDependencies)` in `src/commands/tag.ts`, using the **injectable-DI** style (`state.ts` / `backup.ts` / `harden.ts` pattern), because `completion.spec.ts:66-120` derives the Commander option surface from registrars without spawning a subprocess.

`.configureHelp({ showGlobalOptions: true })` **must** be chained on the parent _before_ any subcommand is created — Commander copies the parent's help config into a subcommand at creation time (load-bearing comment at `commands/state.ts:52-54`).

**Complete option surface** (needed verbatim by the completion parity tests):

| Subcommand    | Options                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tag list`    | `--tree`, `-f/--compose <path>`, `-e/--env-file <path>`, `-p/--profile <name>`, `--json`                                                                            |
| `tag show`    | `-s/--service <name>`, `--services <names>`, `-f`, `-e`, `-p`, `--json`                                                                                             |
| `tag suggest` | `-s/--service <name>`, `--services <names>`, `-g/--group <name>`, `--rule <ids>`, `--list-rules`, `--include-tagged`, `-o/--out <path>`, `-f`, `-e`, `-p`, `--json` |

**No `tag set` / `add` / `remove` in v1** (§10, §13).

**Subcommand naming is constrained by two independent mechanisms:**

1. `resolveStateLockOperation` (`cli.ts:82-123`) tests `ALWAYS_MUTATING_COMMANDS.has(commandName)` on the **bare** subcommand name after only the `drift` / `state` parent branches. A subcommand named `apply`, `build`, `delete`, `deploy`, `prune`, `pull`, `rebuild`, `rollback`, or `stop` would silently acquire the global state lock. `list` / `show` / `suggest` avoid the set, and `resolveStateLockOperation` needs **no edit** — its default branch returns `undefined`, which is already correct for a read-only command. A one-line comment is added recording the invariant so a future author adding a write revisits it.
2. Fish's `__fish_seen_subcommand_from X` matches token `X` **anywhere** on the line. `show` is already taken by `drift show`, so `tag show` needs `and not __fish_seen_subcommand_from drift` **and** `drift show` needs the reciprocal `and not __fish_seen_subcommand_from tag`. `list` and `suggest` are new tokens (verified absent from `completion.ts`).

### 6.2 The `--tag` targeting flag

```text
--tag <pattern>   Narrow targets by hierarchical tag pattern (repeatable, comma-OR)
```

Long-only — no short form (`-t` is unclaimed but `-s` is already overloaded as `--shell` on `completion`, and adding another single-letter selector invites the same class of collision).

Declared with a **pure collector, no default**:

```ts
.option(
  "--tag <pattern>",
  "Narrow targets by hierarchical tag pattern (repeatable)",
  (value: string, previous: string[] | undefined) => [...(previous ?? []), value],
)
```

**No `[]` default.** This is critical and is a fix relative to two of the candidate designs: `commands/update.ts:23-30` and `commands/backup.ts:73-77` both build flag lists with `options.X === undefined ? undefined : "--X"`. With an `[]` default, `options.tag` would never be `undefined`, so `rfapps update --from-plan <path>` would throw on every invocation and `rfapps backup --all` would always report a selector conflict.

**Never an argParser that throws.** Commander v14 `argParser` calls `process.exit(1)` when it throws, before `.action()` runs, bypassing `handleCliError`, the registered formatters, and the exit-code contract. The collector above cannot throw. All pattern parsing and validation happens in `applyTagAxis` (called from the action / resolver) or in the `cli.ts` preAction hook.

A helper `addServiceTargetOptions(command, { group?: boolean; sidecars?: boolean })` in `src/lib/command-options.ts` declares `-s/--service`, `--services`, and optionally `-g/--group` / `--no-sidecars` / `--tag`. It is **parameterized**, because `status` (`cli.ts:355-368`) declares only `-s` and `--services` — it has no `-g` and no `--no-sidecars`, and blanket application would grant it two flags it structurally cannot honor.

### 6.3 Which commands get `--tag`

`--tag` is declared on every command path that already carries `-g/--group`, plus `status`:

**Inline in `cli.ts` (11):** `status`, `health`, `pull`, `build`, `deploy`, `stop`, `rebuild`, `delete`, `prune`, `plan`, `lint`.
**In `src/commands/` (10):** `audit`, `backup`, `doctor`, `drift detect`, `drift reconcile`, `drift import`, `harden`, `import`, `reconcile`, `update`.

**21 command paths.** Not added to `drift show` / `rollback` (single-service `.requiredOption`), `history` (its `-s` is a SQL filter, never a target), or the non-targeting commands.

`delete` and `prune` **do** get `--tag`, because withholding it would leave an inconsistent surface that a future contributor would close inconsistently. The fail-closed empty-match rule (§7.3) is the actual protection, and it is stronger than omission.

### 6.4 Example invocations

```bash
# --- Issue #63's examples (corrected per §3.7) ---
rfapps status  --tag infrastructure            # was: --tag "infrastructure/*"
rfapps rebuild --tag "media/automation" --yes  # was: --tag "media/automation/*"

# --- Selection ---
rfapps plan   --tag media                      # the whole media subtree
rfapps deploy --tag "media/streaming" --yes
rfapps pull   --tag "media/**,photos/**"       # OR within one flag
rfapps stop   --tag "**" --tag "!media/**"     # AND across flags: tagged, not media
rfapps status --tag "**/networking"
rfapps deploy -g arr-stack --tag "media/automation" --yes   # INTERSECTION

# --- Assertion idiom (intersection makes this useful) ---
rfapps stop -s plex --tag "media/**"           # exits 2 if plex is not tagged media

# --- Inspection ---
rfapps tag list
rfapps tag list --tree
rfapps tag list --json
rfapps tag show -s plex
rfapps tag show --services plex,sonarr --json

# --- Inference ---
rfapps tag suggest
rfapps tag suggest --list-rules
rfapps tag suggest --rule tag-infer-ingress,tag-infer-arr
rfapps tag suggest --out tags-fragment.yaml    # flag:"wx", refuses to clobber
```

### 6.5 Output

**Format resolution.** The global `--output` is declared with `.default("text")` (`cli.ts:136-140`), so `program.opts().output` is **never `undefined`**. Each `tag` subcommand carries a local `--json`, so format resolution MUST check the local flag **before** `globalOptions.output`, copying `resolveHardenFormat` (`actions/harden.ts:108-125`) exactly. Otherwise `--json` is permanently dead.

**Non-JSON machine formats.** `TagListResult` and `TagShowResult` are structurally nested. Following the `backup` precedent (`commands/backup.ts:87-94`, which rejects `csv` for lossless evidence), `tag list` and `tag show` **reject `--output csv`** with `InvalidArgumentError("--output", "csv", "Tag output is hierarchical; use json, yaml, or table")`. `--output table` is accepted and renders a flattened `tag | depth | services | count` view via `FormatOptions.columns`.

**Text render — `tag list --tree`** (stdout only; all prose to stderr):

```text
infrastructure                        (2 services)
  core
    identity                          authentik-server
    networking                        traefik
media                                 (5 services)
  automation
    movies                            radarr
    tv                                sonarr
  downloads
    usenet                            sabnzbd
  streaming                           plex
hardware
  gpu                                 plex
photos
  library                             immich-server

Untagged (37): autobrr, bazarr, cloudflared, ...
Source: /home/yandy/Projects/.../rfapps.config.yaml
```

**`tag list --json`:**

```json
{
  "schemaVersion": "tags.v1",
  "tags": [
    {
      "tag": "infrastructure",
      "depth": 1,
      "declared": false,
      "services": ["authentik-server", "traefik"],
      "serviceCount": 2
    },
    {
      "tag": "infrastructure/core/networking",
      "depth": 3,
      "declared": true,
      "services": ["traefik"],
      "serviceCount": 1
    }
  ],
  "totalTags": 14,
  "totalServices": 8,
  "untaggedServices": ["autobrr", "bazarr"],
  "unresolvedServices": [],
  "source": "/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/rfapps.config.yaml"
}
```

**`tag show -s plex --json`:**

```json
{
  "schemaVersion": "tags.v1",
  "services": [
    {
      "service": "plex",
      "declaredTags": ["hardware/gpu", "media/streaming"],
      "effectiveTags": ["hardware", "hardware/gpu", "media", "media/streaming"]
    }
  ]
}
```

**`tag suggest --json`:**

```json
{
  "schemaVersion": "tags.v1",
  "proposals": [
    {
      "service": "traefik",
      "tags": ["network/ingress", "platform/core"],
      "rules": ["tag-infer-ingress", "tag-infer-profile"],
      "confidence": "high",
      "alreadyPresent": false
    }
  ],
  "unresolved": ["arr-scripts"],
  "skippedRules": [],
  "degraded": false,
  "fragment": "tags:\n  mapping:\n    traefik:\n      - network/ingress\n      - platform/core\n",
  "writtenTo": "/abs/path/tags-fragment.yaml"
}
```

### 6.6 Exit codes

**No new resolver in `src/lib/exit-codes.ts`.** Every tag surface is read-only; a `resolveTagExitCode` / `setTagExitCode` pair would be cargo-culted structure.

| Situation                                                                             | Code                                       |
| ------------------------------------------------------------------------------------- | ------------------------------------------ |
| `tag list` / `tag show` / `tag suggest` success (including zero tags, zero proposals) | 0 `Success`                                |
| Malformed tag pattern (`net*`, `a//b`, depth > 8, trailing `/*`)                      | 2 `UsageError` via `InvalidArgumentError`  |
| `--tag` matched no services on a **selector** command                                 | 2 `UsageError` via `TagSelectorEmptyError` |
| Malformed `tags.mapping` in config                                                    | 2 `UsageError` via `ConfigValidationError` |
| `--tag` combined with `backup --all`                                                  | 2 `UsageError` via `InvalidArgumentError`  |
| `--tag` combined with `update --from-plan`                                            | 2 `UsageError` via `InvalidArgumentError`  |
| `--out` target already exists                                                         | 1 `OperationalError` (`flag: "wx"` EEXIST) |
| Compose file unreadable                                                               | 1 `OperationalError`                       |

**`tag list "pattern"` is not a thing** — there is no positional pattern on `tag list`. Query-vs-select would otherwise create two different exit contracts for the same syntax. If you want to know what a pattern selects, `rfapps tag list --json` plus `jq` is the answer, or run the selector command with `--dry-run`.

---

## 7. Resolution pipeline integration

### 7.1 The formal algebra

Let `U` = the set of service names in `compose.yml` (from `parseComposeFile`, `lib/validation.ts:113-138`, mtime+size cached).

```
NAMES   = { --service } ∪ { --services... }        or ∅ if neither flag given
GROUPS  = ⋃ config.groups[g] for each -g           or ∅ if not given

BASE    = NAMES ∪ GROUPS                            if either flag given
        = SENTINEL_ALL                              otherwise

For each --tag occurrence k:
  INC_k = ⋃ { s ∈ U : serviceMatches(p, s) } over positive patterns p in flag k
        = U                                          if flag k has only negations
  EXC_k = ⋃ { s ∈ U : serviceMatches(p, s) } over negated patterns !p in flag k
  T_k   = INC_k \ EXC_k

TAGS    = ⋂_k T_k                                    over all --tag occurrences
        = NO_TAG                                     if there are none

RESULT  = BASE                                       if TAGS = NO_TAG
        = materialize(BASE) ∩ TAGS                   otherwise
              where materialize(SENTINEL_ALL) = U
```

### 7.2 Post-conditions — these ARE the design

**P1 — Backward compatibility is structural.**
`TAGS = NO_TAG` ⟹ `RESULT` is byte-for-byte what today's code produces: either the `[]` sentinel or the name/group union in today's exact insertion order. `applyTagAxis` returns `{ kind: "absent" }` and the tag branch is short-circuited before it runs. Not "equivalent" — unreachable.

**P2 — The sentinel is never reachable through the tag path.**
`TAGS ≠ NO_TAG` and `RESULT = ∅` ⟹ **throw `TagSelectorEmptyError`**. Never return `[]`.

This is the single most important rule in the design. `services: []` is an overloaded sentinel meaning _"no explicit target — let Compose operate on the whole project"_; callers uniformly do `services.length > 0 ? services : undefined` (`actions/lint.ts:390`, `harden.ts:222`, `audit.ts:125`) and omit the service list from the `docker compose` argv. A `--tag` glob that matched nothing and fell through to `[]` would **silently target all 45 services** — including under `rfapps delete`. This follows the precedent already set by `backup` (`actions/backup.ts:571-577`) and `reconcile` (`actions/reconcile.ts:646-657`).

**P3 — Ordering of validation.**
`validateServiceNames` runs on `NAMES ∪ GROUPS` **before** the tag intersection, not after. This is a correction to the top-scoring design, which specified the reverse and thereby made `ServiceNotFoundError` unreachable whenever `--tag` was present: because `TAGS ⊆ U`, any misspelled service name in `BASE` is filtered out by the intersection before validation could see it, so `rfapps deploy -s plexx --tag "media/**"` would report a misleading "tag matched nothing" instead of "did you mean plex?".

**P4 — Tag mapping staleness is diagnosed, not silently swallowed.**
`buildTagIndex` records `unresolvedServices` — services present in `tags.mapping` but absent from `compose.yml`. If a `--tag` selector's _only_ matches came from unresolved entries, `TagSelectorEmptyError`'s message names them explicitly rather than saying "matched no services". `validateTagReferences` surfaces the same set as `ValidationWarning`s (warning severity, never error — see §9).

**P5 — Ordering of results is preserved.**
`TAGS = NO_TAG` ⟹ today's ordering. `TAGS ≠ NO_TAG` ⟹ `BASE`'s order, or `U`'s (compose declaration order) when `BASE = SENTINEL_ALL`. Output is stable and diffable.

**P6 — A tag-derived selection is indistinguishable downstream.**
The result lands in `services` **before line 162**, so `preSidecarCount` / `sidecarsExpanded` stay meaningful (deploy auto-enables `--force-recreate` on expansion), sidecar expansion at `:166-168` behaves normally, and `autoDetectProfiles` at `:175-176` populates the `docker compose --profile` argv correctly.

### 7.3 Why intersection, not union

Issue #63 says _"Filter by tag hierarchy"_ and _"enables sophisticated filtering across 47 services."_ Every industry precedent narrows: `docker ps --filter label=`, `kubectl -l`, Gmail label search, DigiKam tag filters.

The decisive argument is failure mode. Under union, `rfapps deploy -g media-stack --tag "typoo/**"` deploys media-stack anyway — the typo contributes nothing and is **silently ignored**. Under intersection it throws with a fuzzy suggestion. The repo's own guidance is _"Throw errors early and often. Do not use fallbacks that hide real issues."_

**The flag help text says "Narrow", not "Filter"**, so the word matches the behavior at the point of use.

### 7.4 The resolver branch

In `resolveServicesWithInteractive` (`src/lib/interactive-selection.ts:98-179`), the `hasAnyTarget` block becomes:

```ts
const hasAnyTarget = hasExplicitSelector(rawOptions);

if (hasAnyTarget) {
  // 1. BASE: existing group -> service -> services push, unchanged
  //    (lines 110-129 as today)

  // 2. Dedupe BASE, unchanged
  services = [...new Set(services)];

  // 3. Validate BASE names FIRST (P3). Unchanged call, unchanged position
  //    relative to BASE, but now explicitly BEFORE the tag intersection.
  if (services.length > 0) {
    await validateServiceNames(services, composePath);
  }

  // 4. NEW: the tag axis
  const axis = applyTagAxis(rawOptions.tag, await getTagIndex(config, composePath), universe);
  if (axis.kind === "present") {
    const base = services.length > 0 ? services : universe;
    const narrowed = base.filter((s) => axis.matched.has(s));
    if (narrowed.length === 0) {
      throw new TagSelectorEmptyError(
        axis.terms.map((t) => t.source),
        explicitSelectorFlagNames({ ...rawOptions, tag: undefined }),
        [...index.allTags],
        findClosestTag(axis.terms[0]?.source ?? "", index.allTags),
      );
    }
    services = narrowed;
  }
} else if (shouldShowInteractiveSelection({ ...rawOptions })) {
  // unchanged
}

// lines 162-178 unchanged: preSidecarCount, sidecar expansion, autoDetectProfiles
```

`universe` is `await parseComposeFile(composePath)` — already cached by mtime+size at `validation.ts:37-100`, so this adds no filesystem cost on the hot path when `--tag` is absent (the call is inside the `axis.kind === "present"` branch's data flow and is lazily awaited).

`getTagIndex(config, composePath)` memoizes per `(config identity, composePath)` so a single command builds the index at most once.

### 7.5 The six duplicated selector sites — all updated in code

| #   | Site                                                   | Today                                        | After                                                                                                                       |
| --- | ------------------------------------------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | `lib/interactive-selection.ts:101-104`                 | 4 inline lines                               | `hasExplicitSelector(rawOptions)`                                                                                           |
| 2   | `lib/interactive-check.ts:65-67`                       | 3 inline lines                               | `hasExplicitSelector(options)` (+ `tag` on `InteractiveSelectionCheckOptions`)                                              |
| 3   | `cli.ts:260-263` (deploy `--staged` preflight)         | 3 inline lines on raw `actionCommand.opts()` | `hasExplicitSelector(deployOpts)`                                                                                           |
| 4   | `actions/reconcile.ts:646-647` (`hasExplicitSelector`) | 2 inline lines                               | `hasExplicitSelector(options)`; the downstream `InvalidArgumentError` flag-name derivation uses `explicitSelectorFlagNames` |
| 5   | `commands/backup.ts:73-77` (`selectorFlags` array)     | array literal of 3                           | `explicitSelectorFlagNames(options)`                                                                                        |
| 6   | `actions/backup.ts:472-485` (duplicated guard)         | array literal of 3                           | `explicitSelectorFlagNames(rawOptions)`                                                                                     |

Sites 5 and 6 are **mandatory, not optional**. Without them: `rfapps backup --all --tag "media/**"` passes the mutual-exclusion check (which sees only the three legacy flags), the `--all` branch wins, and the whole project is backed up with `--tag` silently ignored; and `rfapps backup --tag "media/**" --yes` computes `explicitTarget = false` and throws _"Backup requires an explicit service target or --all"_ despite having one. Both are wrong-scope bugs on a mutating, lock-taking command.

Additionally, **`commands/update.ts:23-30`** must gain `--tag` in the `--from-plan` conflict list. Verified: the array today is exactly `--service`, `--services`, `--group`, `--compose`, `--profile`, `--no-sidecars`. Without the edit, `rfapps update --from-plan reviewed.json --tag "media/**" --apply` silently re-scopes a frozen, reviewed managed-update plan on a command that holds the global state lock and recreates containers.

After this, **#62 adds a selector axis by editing one function.**

### 7.6 The three injectable `resolveServices` seams

`actions/backup.ts:119-132`, `actions/reconcile.ts:129-142`, and `actions/update.ts:130-143` each re-declare the `resolveServices` signature structurally. Adding `tag` would create a fourth copy. Instead, export from `interactive-selection.ts`:

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

All three DI declarations reference it. The `TExecution` parameter accommodates the existing divergence (`backup` uses `Pick<DockerExecOptions, "env" | "replaceEnv">`; `reconcile`/`update` use `{ envTool?: EnvToolExecConfig }`).

### 7.7 `--profile` and `--all` interaction

`-p/--profile` is **Compose profile activation, not targeting**. It only sets `config.profiles.defaultProfile` via `applyCliOverrides` (`lib/config.ts:544-549`), and the resolver consults `defaultProfile` **only** when `services.length === 0` (`:175-176`). Because `--tag` always produces a non-empty explicit list (P2), `--profile` is silently ignored by the resolver whenever `--tag` is present, exactly as it already is whenever `-s` or `-g` is present. `autoDetectProfiles` wins. **No change; no new interaction.** `applyCliOverrides` is a shallow `{...config}` spread, so `tags` survives it with no edit.

`backup --all` is the only real "target everything" flag, and it becomes **mutually exclusive with `--tag`** for free once sites 5 and 6 above use `explicitSelectorFlagNames`.

`status`'s `-a/--all` means `docker ps -a` (include stopped), **not** "target everything." It is not conflated.

### 7.8 Interactive selection

`--tag` **is** a targeting flag and therefore **suppresses** the Ink multi-select, via site 2 above. Without that edit, `rfapps deploy --tag "media/**"` on a TTY would pop the multi-select — a real, user-visible bug.

Rejected alternative: `--tag` as a pre-filter on the interactive candidate list. `selectServicesInteractive` (`lib/interactive.tsx`) derives its own list from `getComposeServices` and has no filtering seam; adding one means a new `candidates?: string[]` parameter, and a hierarchical tag tree needs a new Ink component, not a tweak to the flat `MultiSelect`. Out of scope.

### 7.9 `status` — the one command off the pipeline

`actions/status.ts` never calls `resolveServicesWithInteractive`. It shells `listContainers(options.all)` → `docker ps --format json` and post-filters on **container names** (`:302-308`). It hardcodes `noSidecars: false` and `yes: false`, has no `-g`, and never computes profiles.

```
1. options.tag === undefined  -> unchanged code path. Nothing new runs.
2. options.tag present:
   a. loadConfig() + applyCliOverrides   (already done at status.ts:261-265)
   b. index = await getTagIndex(finalConfig, composePath)
   c. U = await parseComposeFile(composePath)          // cached
   d. axis = applyTagAxis(options.tag, index, U)
   e. BASE = NAMES from -s/--services, else SENTINEL_ALL
   f. selected = materialize(BASE) ∩ axis.matched
      empty -> throw TagSelectorEmptyError
   g. keep a `docker ps` row iff selected.has(data.Names)
```

**Step (g) uses the service-key fallback only.** Measured: all 45 services in this repo declare `container_name` identical to the service key, with zero exceptions. The `getServiceContainerMap` / `docker compose ps` round-trip proposed by the top-scoring design is **dropped from scope**: `status` today reads no compose file for its container list and shells only a bare `docker ps`; adding a compose subprocess to the hottest command in the CLI to preempt a divergence that does not exist in this deployment is a latency regression bought for a hypothetical. The divergent case (a `container_name` differing from the service key) is recorded in `## Limitations`. If it is ever observed in the field, add the map then.

**`status --tag` composition matches the resolver (intersection), not `status`'s local `-s`/`--services` convention.** `status` today intersects `-s` with `--services` via two independent `continue` guards. Since `--tag` is specified as intersection everywhere, `status --tag "media/**" -s traefik` and `rebuild --tag "media/**" -s traefik` behave identically (both select `traefik` only if it is tagged `media/**`). Divergent semantics for identical syntax across commands is exactly what produces a wrong-target incident, so this is the answer, not a documented limitation.

**`status --tag` matching nothing exits 2**, consistent with every other command. `status -s bogus` exiting 0 today is a pre-existing inconsistency (status never calls `validateServiceNames`); it is not a reason to propagate it.

**Name shadowing.** `actions/status.ts:301` already binds `const { name, tag } = parseImage(data.Image)` inside the exact loop that gains the filter — there, `tag` means the _image tag_. The incoming option must be bound locally as `tagPatterns` / `selectedServices` to avoid conflation. Note also that `ServiceStatus` already has a `tag` field meaning "image tag"; this is called out in the operator doc under `## Limitations` so `rfapps status --tag ... --output json` returning objects with an unrelated `tag` field is not a surprise. **`ServiceStatus` gains no new field** — it is MCP-surfaced via `serviceStatusSchema` (`mcp/schema.ts:218-227`) and anchored by `_typeCheck` at `:1088-1113`.

---

## 8. Auto-inference (`rfapps tag suggest`)

### 8.1 Contract

A **subcommand**, not a flag. Inference is an authoring aid with its own option surface; bolting `--suggest` onto a filter flag would conflate two unrelated jobs and thread it through 21 commands for no benefit.

**It writes nothing to configuration. Ever.** It prints a copy-pasteable YAML fragment to stdout, or writes it to `--out <path>` with `writeFile(path, content, { flag: "wx" })` — the non-clobbering precedent at `actions/harden.ts:272`. It does **not** take the global state lock. It has no `--apply`.

The fragment is a **paste source**, not a loadable config layer — pasting it into `.rfapps.yaml` rather than into the layer that owns `tags:` would shadow the base taxonomy (§5.4). The generated header says so.

### 8.2 Rule catalog

Modelled on `HARDEN_RULES` / `HARDEN_RULE_IDS` (`lib/hardening-rules.ts:321`) so rule ids are completable the same way (`actions/completion.ts:25-30`).

| Rule id              | Signal                                                                                                | Proposal                                                                                                                                                                                      | Confidence | Needs Docker     |
| -------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------- |
| `tag-infer-profile`  | `config.profiles.mapping[s]`                                                                          | root segment: `core`→`platform/core`, `infrastructure`→`platform/infrastructure`, `downloads`→`media/downloads`, `arr-stack`→`media/automation`, `media`→`media/streaming`, `photos`→`photos` | medium     | no               |
| `tag-infer-group`    | membership in `config.groups`                                                                         | second segment from the group slug, e.g. `auth-stack`→`platform/identity`                                                                                                                     | medium     | no               |
| `tag-infer-arr`      | service name matches `/^(son\|rad\|lid\|read\|baz\|prowl)arr$/`, or image matches `linuxserver/.*arr` | `media/automation/arr`                                                                                                                                                                        | high       | name variant: no |
| `tag-infer-database` | image basename ∈ `{postgres, mariadb, mysql, mongo}`                                                  | `data/database`                                                                                                                                                                               | high       | yes              |
| `tag-infer-cache`    | image basename ∈ `{redis, valkey, memcached}`                                                         | `data/cache`                                                                                                                                                                                  | high       | yes              |
| `tag-infer-ingress`  | a `traefik.enable` label is present, or image basename ∈ `{traefik, nginx, caddy, haproxy}`           | `network/ingress`                                                                                                                                                                             | high       | yes              |
| `tag-infer-tailnet`  | a `docktail.service.*` label is present                                                               | `network/tailnet`                                                                                                                                                                             | high       | yes              |

`tag-infer-ingress` is the issue's literal _"Traefik → infer proxy tag."_

```ts
export interface TagInferenceRule {
  readonly id: TagInferenceRuleId;
  readonly description: string;
  readonly confidence: TagInferenceConfidence;
  evaluate(ctx: TagInferenceContext): readonly string[]; // un-normalized proposals
}
```

### 8.3 Reading compose labels safely

`ComposeServiceConfig` (`lib/docker.ts:1068-1086`) has **no `labels` field**, and adding one would widen a type consumed by plan-generation fingerprinting. Instead, declare a **local structural view** in `tag-inference.ts` and cast — the `HardenComposeConfig` precedent at `actions/harden.ts:244`:

```ts
interface TagInferenceComposeService {
  readonly image?: string;
  readonly labels?: Readonly<Record<string, string>> | readonly string[];
}
interface TagInferenceComposeConfig {
  readonly services: Readonly<Record<string, TagInferenceComposeService>>;
}
// const view = composeConfig as unknown as TagInferenceComposeConfig;
```

Both label forms are handled: this repo uses map form in all 27 label-bearing services, but list form is legal Compose. Non-string label values (`docktail.service.enable: true`, `docktail.service.port: 32400` are real in this file) are coerced explicitly and never blindly `String()`-split.

### 8.4 Degraded mode

`getComposeConfig` shells `docker compose config --format json`. If the Docker CLI is unavailable, inference **degrades** to the config-only rules (`tag-infer-profile`, `tag-infer-group`, and the name variant of `tag-infer-arr`), reports `degraded: true`, and lists the skipped rule ids. Fail-soft is correct here because the surface is purely advisory and mutates nothing.

**Honest note on day-one value:** the two config-only rules derive from `profiles.mapping` (45/45 coverage) and `groups` (43/45 coverage), so the offline baseline is largely a re-encoding of taxonomy the operator already has. The genuinely new information comes from `tag-infer-ingress` (26 services with `traefik.enable`), `tag-infer-tailnet` (5 with docktail labels), and `tag-infer-database`/`tag-infer-cache` (5 datastores spanning 3 different groups) — cross-cutting facets that `groups:` cannot express, because a service can only be listed in a group by hand and the datastores are scattered. That is the argument for the feature, and the operator doc states it plainly rather than overclaiming.

### 8.5 Human output

```text
Proposed tags for 45 of 45 services (0 unresolved, 0 rules skipped).

  sonarr             media/automation/arr        tag-infer-arr        high
                     media/automation            tag-infer-profile    medium
  traefik            network/ingress             tag-infer-ingress    high
                     platform/core               tag-infer-profile    medium
  authentik-redis    data/cache                  tag-infer-cache      high
                     platform/identity           tag-infer-group      medium
  ...

Copy the block below into the `tags:` section of rfapps.config.yaml,
or re-run with --out <path>. This fragment is a paste source, not a
loadable config layer.
```

Prose to stderr; the YAML fragment to stdout, so `rfapps tag suggest > frag.yaml` works.

By default only services **without** an existing matching tag are proposed (`alreadyPresent: false`); `--include-tagged` shows everything. `suggest` is therefore idempotent under repeated runs.

`--list-rules` prints the catalog to stderr and returns early (the `actions/harden.ts:146-151` precedent).

---

## 9. Integration checklist

### 9.1 New files

| Path                                  | Change | Why                                                                | Est. LOC |
| ------------------------------------- | ------ | ------------------------------------------------------------------ | -------- |
| `src/types/tags.ts`                   | new    | all tag types, schema version, limits                              | 110      |
| `src/lib/tags/tag-path.ts`            | new    | normalize, validate, `tagAncestors`, compare                       | 140      |
| `src/lib/tags/tag-pattern.ts`         | new    | pattern parse (incl. trailing-`/*` rejection) + DP matcher         | 150      |
| `src/lib/tags/tag-index.ts`           | new    | `buildTagIndex`, `getTagIndex` memo, `unresolvedServices`          | 150      |
| `src/lib/tags/tag-suggestions.ts`     | new    | segment-aware `findClosestTag`                                     | 60       |
| `src/lib/tags/tag-inference-rules.ts` | new    | the 7-rule catalog + `TAG_INFERENCE_RULE_IDS`                      | 140      |
| `src/lib/tags/tag-inference.ts`       | new    | inference engine, degraded mode, fragment renderer                 | 150      |
| `src/lib/tags/index.ts`               | new    | barrel                                                             | 25       |
| `src/lib/selector.ts`                 | new    | `SelectorFlags`, `hasExplicitSelector`, `applyTagAxis`             | 140      |
| `src/lib/command-options.ts`          | new    | parameterized `addServiceTargetOptions`                            | 45       |
| `src/commands/tag.ts`                 | new    | registrar + `validateTagShowOptions` / `validateTagSuggestOptions` | 160      |
| `src/actions/tag.ts`                  | new    | `executeTagList`, `executeTagShow`                                 | 190      |
| `src/actions/tag-suggest.ts`          | new    | `executeTagSuggest` (split to stay under the cap)                  | 150      |

All comfortably under the ~500-line soft cap, split by responsibility not arbitrarily. **Growth rule:** if `tag-index.ts` passes ~250, the `unresolvedServices` derivation moves to its own module; if `tag-inference.ts` passes ~300, keep the engine and let `tag-inference-rules.ts` absorb the catalog — the `hardening.ts` / `hardening-rules.ts` split.

### 9.2 Modified — types and config

| Path                             | Change                                                                            | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types/options.ts:48-57`     | `tag?: string[]` on `ServiceTargetOptions`                                        | fans out to 12 option interfaces in one edit                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/types/config.ts:125-154`    | `tags?: TagConfig` on `RfappsConfig`                                              | config section, step 2 of 4                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/types/config.ts:159-174`    | `tags: Partial<TagConfig>` on `PartialRfappsConfig`                               | step 3 of 4                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/types/index.ts`             | re-export `tags.js` (value export for the const, `export type {}` for interfaces) | barrel convention                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/lib/config.ts:120-178`      | `mergeConfig` `tags` branch                                                       | step 4a — omitting it makes the section vanish at a merge layer                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/lib/config.ts:184-271`      | `partialToFull` `tags` branch with `{}` default                                   | step 4b — must **not** join the four required-field throws                                                                                                                                                                                                                                                                                                                                                                                          |
| `src/lib/index.ts`               | re-export `selector.js`, `command-options.js`, `tags/index.js`                    | barrel convention                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/lib/validation.ts:~199-227` | add `validateTagReferences` + `validateTagLayerOwnership`                         | beside `validateGroupReferences`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/lib/validation.ts:301-344`  | call both from `validateConfigAgainstCompose`                                     | **warning severity only** — `validateGroupReferences` uses `severity: "error"` and `actions/deploy.ts:392-406` calls `hasErrors()` and aborts, so an error-severity tag check would block every deploy on one stale entry. Also: the function wraps its body in try/catch converting any throw to `{severity:"error"}`, so **`validateTagReferences` must not throw** — it catches syntax errors from `buildTagIndex` and reports them as warnings. |

### 9.3 Modified — the targeting pipeline

| Path                                                                                                                                         | Change                                                                                                        | Why                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `src/lib/interactive-selection.ts:36-55`                                                                                                     | `tag?` on `ResolveOptions`; **export** it as `ResolveServicesSelection`; export `ResolveServicesFn`           | kills the 3 duplicated DI signatures                                             |
| `src/lib/interactive-selection.ts:101-104`                                                                                                   | `hasExplicitSelector`                                                                                         | selector site 1                                                                  |
| `src/lib/interactive-selection.ts:106-160`                                                                                                   | tag branch per §7.4; `validateServiceNames` moved to run on BASE before the intersection                      | P2, P3, P4, P6                                                                   |
| `src/lib/interactive-check.ts:31-40,65-71`                                                                                                   | `tag` on the options shape; delegate to `hasExplicitSelector`                                                 | selector site 2 — else `--tag` pops the Ink multi-select                         |
| `src/cli.ts:260-263`                                                                                                                         | `hasExplicitSelector(deployOpts)`                                                                             | selector site 3 (deploy `--staged`)                                              |
| `src/actions/reconcile.ts:646-657`                                                                                                           | `hasExplicitSelector` + `explicitSelectorFlagNames`                                                           | selector site 4 — else a zero-match tag reconciles the fleet                     |
| `src/commands/backup.ts:73-77`                                                                                                               | `explicitSelectorFlagNames(options)`                                                                          | selector site 5 — else `--all --tag` silently backs up everything                |
| `src/actions/backup.ts:472-485`                                                                                                              | `explicitSelectorFlagNames(rawOptions)`                                                                       | selector site 6 — else `backup --tag --yes` throws "requires an explicit target" |
| `src/commands/update.ts:23-30`                                                                                                               | add `--tag` to the `--from-plan` conflict list                                                                | else a reviewed managed-update plan is silently re-scoped                        |
| `src/actions/backup.ts:119-132`, `reconcile.ts:129-142`, `update.ts:130-143`                                                                 | reference the shared `ResolveServicesFn`                                                                      | kills a would-be 4th structural copy                                             |
| 16 direct call sites: `actions/{health,deploy,rebuild,pull,stop,build,audit,delete,import,harden,doctor,plan,lint,prune}.ts` + `drift.ts` ×2 | add `tag: options.tag` to the resolve object; add `tag: rawOptions.tag` to each raw→typed builder             | mechanical fan-out                                                               |
| `src/actions/status.ts:231-310`                                                                                                              | the bespoke path per §7.9; bind incoming patterns as `tagPatterns` to avoid shadowing `tag` from `parseImage` | `status` bypasses the resolver                                                   |

### 9.4 Modified — command registration

| Path                                                                         | Change                                                                                                                                                                                                                     | Why                                                                       |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `src/cli.ts`                                                                 | apply parameterized `addServiceTargetOptions` to the 11 inline commands (**`status` opts out of `-g`/`--no-sidecars`**); import + call `registerTagCommand(program)` beside `:393-400`                                     | declares `--tag`, avoids granting `status` flags it cannot honor          |
| `src/commands/{audit,backup,doctor,drift,harden,import,reconcile,update}.ts` | apply `addServiceTargetOptions`                                                                                                                                                                                            | declares `--tag` on 10 more paths                                         |
| `src/cli.ts:152-352` (preAction)                                             | dispatch `validateTagShowOptions` / `validateTagSuggestOptions` on `parentName === "tag"`; pre-parse `--tag` syntax so a malformed pattern fails **before** the state lock is acquired                                     | matches `validateHardenOptions` / `validateBackupCreateOptions` precedent |
| `src/cli.ts:82-123` (`resolveStateLockOperation`)                            | **no code change**; add a comment recording that `rfapps tag` is read-only and must not take the lock, and that the bare-subcommand-name check makes `apply`/`delete`/etc. dangerous names for any future `tag` subcommand | the default branch already returns `undefined`                            |

### 9.5 Errors

| Path                                                                   | Change                                                                                                                                                                                        | Why                                                               |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `src/lib/errors.ts`                                                    | `TagSelectorEmptyError`                                                                                                                                                                       | the one case needing a bespoke message + segment-aware suggestion |
| `src/lib/error-formatters.ts:11-28`                                    | import it                                                                                                                                                                                     |                                                                   |
| `src/lib/error-formatters.ts` inside `registerRfappsErrorFormatters()` | register with `exitCode: ExitCode.UsageError`; position is **not** load-bearing (all 15 formatters are `instanceof`-exact, no catch-all, and this extends `Error` not `InvalidArgumentError`) |                                                                   |

Formatter output:

```text
Error: Tag selector matched no services: media/automaton

  The selector also included: --group arr-stack
  --tag narrows the selection; it does not widen it.

Suggestions:
  Did you mean 'media/automation'?
  Run 'rfapps tag list' to see all 14 known tags
  Drop --group arr-stack to search all tagged services
  Run with --debug for more details
```

When `TagIndex.unresolvedServices` is non-empty and the pattern would have matched one of them (P4):

```text
Error: Tag selector matched no services: media/streaming

  'tags.mapping' assigns this tag to services that are absent from compose.yml:
    plex-old, jellyfin-legacy

Suggestions:
  Remove the stale entries from tags.mapping in rfapps.config.yaml
  Run 'rfapps validate' to see every stale tag reference
  Run with --debug for more details
```

### 9.6 Shell completion — all three templates

**Prerequisite, as a separate PR:** split the 1678-line `src/actions/completion.ts` into `src/actions/completion/{index,bash,zsh,fish}.ts`. Pure move, no behavior change, fully pinned by the existing 794-line parity suite. This lands **first, alone**, so the tag PR does not carry a ~3400-line mechanical diff. See §12.

| Path                              | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Why                                                                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/actions/completion/index.ts` | derive `tagValues` from `config.tags?.mapping` — **`Object.values(mapping).flat()` plus ancestor closure, sorted and deduped** (NOT `Object.keys`, which would offer service names as tag completions), the `hardenRuleIds` pattern at `:25-30`. Also derive `TAG_INFERENCE_RULE_IDS.join(" ")`.                                                                                                                                                                                                                                                                                                                                                                                                                                               | tag values must be reachable from `RfappsConfig` at generation time — `executeCompletion` calls only `loadConfig()`; Docker and `initializeDatabase()` are forbidden |
| `src/actions/completion/bash.ts`  | `tag` in the command list (`:48`); `\|tag` in the command-detection alternation (`:186`); a nested-subcommand branch mirroring `drift`/`state` (`:195-200`); `local tag_list_opts` / `tag_show_opts` / `tag_suggest_opts`; `--tag` appended to 21 `*_opts` strings; `local tags="${tagValues}"`; **`--tag` added to BOTH the value-taking flag list at `:158` and the `--flag=*` alternation at `:161`** (else `rfapps deploy --tag media <TAB>` misparses); a `--tag)` arm in the `case "$prev"` dispatcher with **comma-segment handling copied from `__rfapps_service_completion`'s `${cur%,*}` / `${cur##*,}` idiom at `:220`** (`--tag` is comma-separated); a `tag)` arm in the final case at **exactly 8-space `tag)` / 10-space `;;`** | bash parity                                                                                                                                                          |
| `src/actions/completion/zsh.ts`   | `'tag:Inspect hierarchical service tags'` in the description array (`:507-536`); `\|tag` in `__rfapps_find_command` (`:558`); `'--tag[Narrow targets by tag pattern]:tag:_values -s , tag ${tagValues}'` on each of 21 commands (`_values -s ,` gives comma-separated completion, the `hardenRuleIds` idiom at `:948`); a two-level `tag)` arm at **exactly 16-space / 18-space** indentation (parity regex at `completion.spec.ts:164`, `:209`)                                                                                                                                                                                                                                                                                               | zsh parity                                                                                                                                                           |
| `src/actions/completion/fish.ts`  | `complete -c rfapps -n "__fish_use_subcommand" -a "tag"`; per-option `complete` lines with `-xa "(__rfapps_complete_tags)"`; a `__rfapps_complete_tags` helper handling comma segments like `__rfapps_complete_services_list` (`:1135-1154`); **`tag show` guarded with `and not __fish_seen_subcommand_from drift`, and the reciprocal `and not __fish_seen_subcommand_from tag` added to the existing `drift show` lines**                                                                                                                                                                                                                                                                                                                   | fish parity; `show` is a taken global token                                                                                                                          |

Templates are JS template literals: every runtime shell `$` is written `\$`, every literal backslash `\\`. `${profiles}`, `${groups}`, `${services}`, `${hardenRuleIds}`, `${tagValues}`, `${tagRuleIds}` are the only intentional interpolations.

### 9.7 MCP — deliberately NOT surfaced

**No `tag` key anywhere in `src/mcp/`.** Not in `McpTargetArgs` (`schema.ts:57-62`), not in `targetArgShape` (`:189-194`), not in `statusTargetArgShape` (`:202-205`), not in any `*InputSchema`, and no `rfapps.tag` tool in `RFAPPS_MCP_TOOL_NAMES` (`:1069-1086`). `src/mcp/tools.spec.ts:118-124` / `:182-192` need no change.

Reasons:

1. **Precedent.** `harden`, `lint`, `audit`, `doctor`, `backup`, `update`, `reconcile`, `import`, and `state` are all deliberately CLI-only (`CLAUDE.md:370-373`). The `--scan`/`--scanner`/`--scan-fail-on` flags are likewise absent from `planInputSchema`/`deployInputSchema` by design.
2. **Blast radius.** Adding `tag` to `targetArgShape` widens 7–10 tool schemas at once, with no MCP consumer asking for it.
3. **Runtime trap.** `schemaObject` is `additionalProperties: false` and its strict-key check iterates `Object.keys(input)` (`packages/rf-common/src/mcp/schema.ts:423-436`), so `{ tag: undefined }` throws `Unexpected properties at $: tag` at MCP runtime while typechecking clean, and `runActionWithJsonCapture` hands the raw object to `outputSchema.parse` with no JSON round trip.

**Verified safe by construction:** `invokeStatus` (`adapters.ts:206-228`) and every sibling build their option object with **explicit literal keys and no spread**, so adding `tag?` to the TypeScript `ServiceTargetOptions` cannot leak a `tag` key onto the MCP path. `applyTagAxis` sees `undefined` and returns `{ kind: "absent" }`, so every MCP-driven invocation behaves exactly as before #63.

**Invariant to record in `packages/rfapps-cli/CLAUDE.md` in the same commit:**

> The MCP adapters build raw CLI option objects literally and **must never create a `tag` key** — not even set to `undefined`. The rule is "never create the key", not "never populate it". Additionally, there is **no config-level default tag filter**: `--tag` is always explicit CLI input, so an MCP `rfapps.plan` / `rfapps.deploy` call can never be silently narrowed — the exact hazard `CLAUDE.md:328-329` records for `ScanConfig`.

Since no result type gains a field, the output side needs no change and the `_typeCheck` anchor (`schema.ts:1088-1113`) stays green.

### 9.8 Documentation

| Path                                                                             | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Why                                      |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `docs/features/rfapps-tag-selector.md`                                           | **NEW** operator contract, following the `rfapps-harden-command.md` skeleton: H1; negative-space lead ("never writes compose.yml, never writes the state database, never writes configuration, never takes the global state lock"); `## Selector Algebra` (§7.1 equations); `## Tag Path Grammar`; `## Glob Semantics` (§3.6 table verbatim); `## Common Surprises`; `## Command Syntax` (text usage + option table + annotated bash); rejected-combination prose with exit codes; `## Inference Rule Catalog`; `## Machine Result Contract`; `## Exit Codes`; `## Limitations`; `## Related Documentation` linking `../../packages/rfapps-cli/README.md#tag`, `output-formats.md`, `json-output.md`, `error-handling.md` | every shipped feature has one            |
| `docs/README.md` § `### Feature Documentation` → `**CLI Features:**` (~`:48-68`) | register the bullet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | discoverability                          |
| `packages/rfapps-cli/README.md:199` `## Commands`                                | a `### tag` section (the anchor `docs/features/*` links to) + `--tag` rows in every affected option table                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | anchor target                            |
| `docs/features/quick-reference.md:5`                                             | a `### Tag Selectors` cheat sheet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | convention                               |
| `docs/features/shell-completion.md:114-123`                                      | add `tag` to the **hardcoded command-name comment block**; add `### Tag Completion Behavior` and `### Tag Values` (mirroring `### Harden Rule Ids` at `:452`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | that block goes silently stale otherwise |
| `docs/features/json-output.md`                                                   | `### tag Command` with all three envelopes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | convention                               |
| `docs/features/output-formats.md`                                                | `### Tag List Table` + the csv rejection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | convention                               |
| `docs/features/error-handling.md:29,104,126,320`                                 | exit semantics, a `### Tag Selector Exit Semantics` block, a sample `TagSelectorEmptyError` message, error category                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | convention                               |
| `docs/features/rfapps-configuration.md:24,130`                                   | the `tags:` section in `### Complete Example` and `### Optional Fields`, **with the wholesale-replacement shadowing hazard stated loudly**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | mandatory for any new config section     |
| `docs/features/rfapps-mcp-server.md`                                             | record that tags are deliberately CLI-only, matching how harden/lint/audit/doctor exclusions are documented                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |                                          |
| `packages/rfapps-cli/CLAUDE.md`                                                  | `### Tag Selector Architecture` with call-chain block + `Invariants:` list (P1–P6, never-create-the-MCP-key, no-state-lock, read-only-in-v1, non-throwing collector, trailing-`/*`-rejected) + pointer to the operator doc                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | every shipped feature has one            |
| `packages/rfapps-cli/AGENTS.md`                                                  | the same section — it is a near-mirror of `CLAUDE.md` and already carries the architecture sections; omitting it makes the two drift further                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |                                          |
| `rfapps.config.yaml`                                                             | a **commented-out** `tags:` template block after `harden:`, mirroring the inactive `scan:`/`harden:` blocks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | zero behavior change, discoverable       |
| `ROADMAP.md:78,123`                                                              | mark #63 delivered; record that #62 extends `SelectorFlags` rather than inventing a parallel mechanism; record the v2 writer as a filed follow-up                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |                                          |
| `docs/plans/63-hierarchical-tag-selector/{design.md,plan.md}`                    | tracked plan pair, committed as `docs(internal): …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | last four features each shipped one      |

**Docs ship in the same PR as code** — `.github/workflows/rfapps-cli.yml` is path-filtered to `packages/rfapps-cli/**`, `packages/rf-common/**`, `package.json`, `package-lock.json`, and the workflow file, so a docs-only PR gets **zero CI runs**. Push CI is dead (the workflow targets `main`; the default branch is `master`), so the PR run is the only gate.

---

## 10. Out of scope for v1

- **Tag mutation** — `rfapps tag set` / `add` / `remove`. Issue #63's literal `rfapps tag -s traefik infrastructure/core/networking`. See §13 for the forward design and the follow-up-issue commitment.
- **Writing any config file.** `tag suggest --out` writes a _new_ fragment with `flag: "wx"`; it never modifies an existing config.
- **Compose-label storage or writes.** §5.3.
- **State-DB storage.** §5.3.
- **MCP surfacing.** §9.7.
- **Runtime/dynamic criteria** — `docker stats`, health status, image age. That is #62.
- **Tag-aware interactive selection** — no `candidates?` seam on `selectServicesInteractive`, no hierarchical Ink component.
- **Trailing `/*` patterns.** §3.7.
- **Partial-segment wildcards** — `net*`, `*working`, `a**b`, `?`. §3.4.
- **Set algebra beyond include/exclude** — no explicit union operator, no parenthesization.
- **`--tag` on `drift show`, `rollback`, `history`.**
- **Refactoring `status` onto the resolver.** Touches `StatusOptions`, `statusTargetArgShape`, and `-a/--all` semantics.
- **`getServiceContainerMap` / `docker compose ps` bridge for `status`.** §7.9.
- **Deep-merge of `tags.mapping` across config layers.** §5.4.
- **`RFAPPS_TAGS` env var.**
- **A `tags` field on `ServiceChange` or `ServiceStatus`.**
- **A `resolveTagExitCode` / `setTagExitCode` pair.**
- **An rfapps-cli architecture-check script** (rfmedia-cli has one; rfapps-cli does not, and adding one is orthogonal).

---

## 11. Critical tests only

Repo policy: _"Do not create unnecessary tests, only critical or required tests."_ Vitest; `*.spec.ts` under `packages/rfapps-cli/src/` **only** (`vitest.config.ts:9` — a spec under `packages/rfapps-cli/test/` never runs). `beforeEach(() => vi.clearAllMocks())`, never `resetAllMocks`. `registerRfappsErrorFormatters()` in `beforeAll`, never `beforeEach` (module-level singleton registry).

### New files

| File                                 | Named behaviors                                                                                                                                                                                                                                                                  | Why REQUIRED                                                                                                                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/tags/tag-pattern.spec.ts`   | the §3.6 table verbatim, table-driven; trailing `/*` rejected with the corrective suggestion; partial-segment wildcards rejected; multiple `**`; negation-only term selects untagged                                                                                             | A wrong matcher does not fail loudly — it silently targets the wrong containers on `deploy`/`delete`. Highest blast-radius-per-line in the feature.                                                 |
| `src/lib/tags/tag-path.spec.ts`      | idempotent normalization; case folding; single leading/trailing slash stripped; `a//b` rejected; depth/length limits; `tagAncestors` exact output incl. the depth-1 no-op                                                                                                        | Normalization decides what the matcher compares; rejection is the fail-fast boundary. A regression turns bad config into wrong targeting instead of an error.                                       |
| `src/lib/tags/tag-index.spec.ts`     | ancestor closure builds `effective` correctly; `byTag` inverse; `unresolvedServices` populated for a mapping entry absent from compose; `findClosestTag` returns a suggestion where the shared `findClosestMatch` returns none (the ~0.34 case)                                  | `tag-index.ts` is 150 LOC of bespoke logic including the segment-aware matcher the design spends §3.9 justifying. Covering it only transitively through `selector.spec.ts` was a judge-flagged gap. |
| `src/lib/selector.spec.ts`           | `hasExplicitSelector` for all four axes and both `services` shapes (comma string AND array), `""` and `[]` treated as absent; `explicitSelectorFlagNames` output; `applyTagAxis` returns `{kind:"absent"}` for `undefined` and for `[]`; AND-across-flags / OR-within-flag       | Pins P1 and the dual-shape `services` typing. This function is the only thing standing between a typo'd glob and a full-fleet operation, and it is called from six sites.                           |
| `src/commands/tag.spec.ts`           | registration smoke test spawning the real CLI for `tag list --help` / `tag suggest --help` (asserts `Usage:`, every flag, `Global Options:`); lazy-load assertion — injected `vi.fn()` loaders never called during registration or `helpInformation()`                           | The lazy-load assertion mechanically enforces the dynamic-import invariant; `commands/state.spec.ts` establishes both as the mandatory 2-test shape.                                                |
| `src/lib/tags/tag-inference.spec.ts` | `executeTagSuggest` writes **nothing** to config under every mode; `--out` with an existing file throws; degraded mode reports `degraded: true` + `skippedRules` when `getComposeConfig` rejects; `tag-infer-ingress` fires on a `traefik.enable` label (map form AND list form) | Only the never-mutates-config guarantee is safety-critical. The two rule cases cover the label-shape branch (the one place a real bug hides). Not testing all 7 rules is deliberate.                |

### Extended files

| File                                                          | Added cases                                                                                                                                                                                                                                                                                                                                            | Why REQUIRED                                                                                                                                                                                             |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/interactive-selection.spec.ts` (37 existing)         | `--tag` intersects with `-s`/`-g` rather than unioning; a zero-match tag throws `TagSelectorEmptyError` and **never** returns `[]`; `-s <typo> --tag <valid>` throws `ServiceNotFoundError` (P3, not a tag error); tag-resolved services reach `autoDetectProfiles` so `profiles` is non-empty; `preSidecarCount` reflects the post-intersection count | These 37 tests are the backward-compat contract for 19 commands. P2 and P3 are the two rules a reviewer must be able to see proven.                                                                      |
| `src/lib/interactive-check.spec.ts`                           | `--tag` alone suppresses interactive selection                                                                                                                                                                                                                                                                                                         | One production line, but omitting it makes `rfapps deploy --tag "media/**"` pop the Ink multi-select on a TTY.                                                                                           |
| `src/actions/completion.spec.ts` (794 existing)               | `"tag"` in the command list (`:372-394`); `--tag` in the required-token list (`:680-702`); a `tag`-arm parity extractor for all three shells; `mockConfig` (`:43-64`) gains a `tags` key; **an empty-interpolation guard** `expect(script, shell).toContain("media/streaming")` mirroring the `harden-no-new-privileges` guard at `:605`               | Not optional — existing assertions fail the moment `tag` is registered. The literal guard is the only way to detect an empty `${tagValues}`; option-name parity assertions are structurally blind to it. |
| `src/commands/backup.spec.ts`                                 | `backup --all --tag "x"` throws the mutual-exclusion error; `backup --tag "x" --yes` does **not** throw "requires an explicit target"                                                                                                                                                                                                                  | Both are wrong-scope bugs on a lock-taking, mutating command if selector sites 5/6 are missed.                                                                                                           |
| `src/commands/update.spec.ts`                                 | `update --from-plan p.json --tag "x"` throws; `update --from-plan p.json` alone does **not** throw (guards the no-`[]`-default rule)                                                                                                                                                                                                                   | The second case is the regression test for the Commander-default trap in §6.2.                                                                                                                           |
| `src/lib/config.test.ts`                                      | a `tags:` block in a higher layer replaces the base's wholesale                                                                                                                                                                                                                                                                                        | Pins the documented footgun; also the only coverage of any `mergeConfig` optional-section branch.                                                                                                        |
| `src/lib/errors.spec.ts` + `src/lib/error-formatters.spec.ts` | one case each for `TagSelectorEmptyError` (fields; formatted message + suggestions + `ExitCode.UsageError`)                                                                                                                                                                                                                                            | Repo convention for every new error class.                                                                                                                                                               |
| `src/cli.status.integration.spec.ts`                          | `status --tag <pattern>` filters `docker ps` rows by service key, exits 0 with JSON; `status --tag <no-match>` exits 2                                                                                                                                                                                                                                 | `status` is off the chokepoint and is the issue's headline example.                                                                                                                                      |

### Deliberately NOT tested — with reasons

- **Per-command `--tag` declaration across all 21.** Covered by the chokepoint spec + completion parity (exact set equality per command) + `tsc --noEmit`. Twenty-one near-identical specs is exactly the unnecessary duplication the policy forbids.
- **`tag list` / `tag show` text and tree rendering.** Cosmetic; zero blast radius.
- **The YAML fragment string byte-for-byte.** Advisory output; the never-writes guarantee is what matters and it is tested.
- **All seven inference rules.** Advisory, read-only, and correctness is a judgement call. The two tested cover the label-shape branch.
- **`TagSelectorEmptyError` message wording beyond one formatter case.**
- **A `cli.tag.integration.spec.ts`.** No Docker I/O; the help smoke test in `commands/tag.spec.ts` covers Commander wiring.

### Gates

Absolute paths only — the main checkout sits at the same HEAD, so relative-path commands pass **vacuously against the wrong tree**. A fresh worktree needs bootstrap first, run **serially**:

```bash
cd <worktree-abs-path> && npm ci
cd <worktree-abs-path> && npm run build -w packages/rf-common
```

CI parity (the actual merge gate):

```bash
cd <worktree-abs-path> && npm run typecheck --workspace packages/rfapps-cli
cd <worktree-abs-path> && umask 022 && env -u FORCE_COLOR npm run test:coverage --workspace packages/rfapps-cli
```

Repo-policy gates (in the PR `## Testing` block):

```bash
cd <worktree-abs-path> && npm run format:check
cd <worktree-abs-path> && npm run typecheck            # all 3 workspaces
cd <worktree-abs-path> && npm run lint:md
cd <worktree-abs-path> && npm run test:run             # pre-push hook parity
cd <worktree-abs-path> && graphify update .
```

`npm run test:run` applies `umask 022` and unsets `FORCE_COLOR` internally (`scripts/test-run.sh:26-33`). **Never** wire `npm test` into a hook or CI step — it is bare `vitest` (watch mode).

Baseline to beat at `c54b647b`: **109 files / 1566 tests passing in ~17 s**; `format:check` clean; `lint:md` clean for tracked files (the 16 pre-existing errors are all under `.claude/worktrees/**/research/**`).

`rfapps.config.yaml` is **not** in `.prettierignore` and **is** covered by `format:check`, so the commented-out `tags:` template block must be prettier-clean.

---

## 12. Risks and mitigations

| #   | Risk                                                                                                                   | Mitigation                                                                                                                                                                                                                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **A zero-match `--tag` reaches the `[]` sentinel and targets all 45 services**, including under `rfapps delete`.       | P2 as a structural rule: `applyTagAxis` never returns `[]`; the resolver throws. Pinned by `interactive-selection.spec.ts`. The check is scoped to the tag intersection, evaluated after BASE validation, so `-s traefik --tag "typo/**"` still throws.                                               |
| 2   | **The six selector sites desync**, silently arming an undeclared command.                                              | All six updated in code, not comments. `SelectorFlags` accepts both `services` shapes so the two raw-Commander sites typecheck honestly. `commands/backup.spec.ts` and `commands/update.spec.ts` pin the two highest-consequence sites.                                                               |
| 3   | **`--tag` declared with a Commander `[]` default** breaks `update --from-plan` and `backup --all` on every invocation. | No default on the collector (§6.2), and `hasServicesSelector`/`hasExplicitSelector` treat `[]` as absent regardless. `update.spec.ts` has an explicit "does not throw without --tag" regression case.                                                                                                 |
| 4   | **Ancestor closure surprises an operator.**                                                                            | Trailing `/*` — the worst trap — is rejected outright with a corrective message (§3.7). The remaining rule (`X ≡ X/**` = whole subtree) matches intuition. The §3.6 table and a `## Common Surprises` block go in the operator doc verbatim.                                                          |
| 5   | **`status` split-brain**: two implementations of the same semantics.                                                   | Both call the same `applyTagAxis`; only the row-filtering differs. Pinned end-to-end by `cli.status.integration.spec.ts`. Recorded as an invariant in `CLAUDE.md`.                                                                                                                                    |
| 6   | **`.rfapps.yaml` `tags:` silently shadows the base taxonomy.**                                                         | `validateTagLayerOwnership` warning; `TagListResult.source` reports the winning layer; documented in `rfapps-configuration.md` and `## Limitations`. Named as the most likely v2 reversal.                                                                                                            |
| 7   | **Stale `tags.mapping` entries produce a confusing "matched nothing."**                                                | `TagIndex.unresolvedServices` + P4's dedicated error message + `validateTagReferences` warnings.                                                                                                                                                                                                      |
| 8   | **`validateTagReferences` blocks every deploy.**                                                                       | Warning severity only, and it must **not throw** — `validateConfigAgainstCompose` converts any throw into `{severity:"error"}` and `deploy.ts:392-406` aborts on `hasErrors()`. `validateTagReferences` catches `buildTagIndex` syntax errors and reports them as warnings.                           |
| 9   | **`${tagValues}` interpolates empty and ships dead completion.**                                                       | The `expect(script).toContain("media/streaming")` literal guard in `completion.spec.ts`, mirroring `:605`. `mockConfig` gains a `tags` key so the guard has something to find.                                                                                                                        |
| 10  | **Completion PR-size blowup / broken parity extractors.**                                                              | Completion split lands as a **separate, prior PR** (§9.6), pinned by the existing suite. Zsh arm indentation (8/10 top-level, 16/18 nested) is called out explicitly in the checklist.                                                                                                                |
| 11  | **A day-one taxonomy does not exist**, so every `--tag` throws until someone authors one.                              | `tag suggest` generates a paste-ready fragment for all 45 services in one command. The shipped config carries a commented-out template. `tag list` on an empty taxonomy exits 0 with a stderr pointer to `tag suggest`. This is a real onboarding cost and is stated in `## Limitations`, not hidden. |
| 12  | **The DP matcher does not compile** under `noUncheckedIndexedAccess: true`.                                            | Called out explicitly in §3.5 with the fix. `npm run typecheck --workspace packages/rfapps-cli` is a merge gate.                                                                                                                                                                                      |
| 13  | **`ServiceStatus.tag` already means "image tag"** and collides conceptually with `--tag`.                              | No result field is added; the local binding is renamed (`tagPatterns`); the collision is documented in `## Limitations`.                                                                                                                                                                              |
| 14  | **The issue's literal examples do not work as written** (`--tag "infrastructure/*"`, `rfapps tag -s …`).               | Both fail loudly with corrective messages, not silently. Raised on the issue before implementation (§13).                                                                                                                                                                                             |

---

## 13. Rejected concerns

Judge-raised fatal flaws that this design does **not** fix, each with the reasoning.

### 13.1 "The design does not deliver issue #63's headline example `rfapps tag -s traefik <tag>`, so `Closes #63` is not honestly claimable."

**Partially accepted; the process fix ships, the writer does not.**

The writer is genuinely expensive and genuinely risky, and none of that risk buys capability the fragment does not deliver:

- It is the **first read-modify-write config path in the package.** `actions/init.ts:336` is create-only, targets `.rfapps.yaml`/`~/.rfapps.yaml`, and uses `YAML.stringify`, which destroys the 190 lines of comments in the shipped config.
- It needs **layer discovery that does not exist.** `loadConfig` (`config.ts:438-500`) returns only `RfappsConfig` and discards every layer path; `findConfigFile` is module-private; the only exported helpers are `getProjectConfigPath()`, `getDefaultConfigPath(global)`, and `getStateDbPath(config)`. Resolving "the highest-precedence file that already declares `tags:`" is net-new code duplicating `loadConfig`'s precedence order.
- Its **round-trip stability is file-dependent.** `parseDocument(rfapps.config.yaml).toString()` is byte-identical _on this repo's file_, which happens to be block-style with 2-space indentation. A flow sequence longer than the default `lineWidth` 80 explodes into a block; 4-space indentation reindents. A refuse-on-unstable-round-trip guard fails **closed** rather than corrupting — good — but it means `rfapps tag set` would hard-refuse on a meaningful fraction of real configs with "reformat your file by hand first," which is worse UX than no command.
- Its output must additionally be **prettier-clean**, because `rfapps.config.yaml` is not in `.prettierignore` and `format:check` is a repo gate. The round-trip guard compares the _unmodified_ document to source and cannot catch a modified output that prettier would reformat.
- And the value delta over `tag suggest --out` is small: authoring 45 services one `tag set` invocation at a time is ~90 read-modify-writes of a git-tracked file. Nobody does that. They paste the fragment once.

**What ships instead of hand-waving:** before implementation begins, a comment is posted on #63 stating that (a) v1 delivers the query/filter/suggest layer, (b) `--tag "infrastructure/*"` becomes `--tag infrastructure` with the reason, and (c) the writer is deferred. A follow-up issue `[rfapps-cli] rfapps tag set/remove — config writer` is filed with the forward design below, and `ROADMAP.md` records it. The PR body says `Refs #63`, and #63 is closed only after the maintainer confirms the scope split. **No PR claims `Closes #63` without that confirmation.**

**Forward design for the writer (v2), so the gap is bounded rather than open:** resolve the target layer as _"the highest-precedence config file that already declares `tags:`, else the project base `rfapps.config.yaml`"_ — never defaulting to `.rfapps.yaml`, which would create a shadowing layer by accident. Read **raw file text** (never serialize the loaded `RfappsConfig`, which has `injectSecrets`-resolved `{{ VAR }}` templates and host-absolute `composePath`/`envFile` baked in at `config.ts:291,494-495`, in a git-tracked file). Parse with `parseDocument`. **Assert `doc.toString({ lineWidth: 0, flowCollectionPadding: false }) === source` on the unmodified document and refuse otherwise** — a runtime invariant, not a one-time measurement. Detect and preserve source indentation. `setIn(["tags","mapping",service], seq)`. Verify the output is prettier-clean. Write atomically: temp + `chmod`(original mode) + `rename`, per `actions/harden.ts:324-327`. Still **no** global state lock. Last-writer-wins across concurrent invocations, documented.

### 13.2 "Scope is ~50 files against an issue estimating 3–5; it is not a reviewable PR."

**Accepted, and fixed by decomposition rather than by shrinking the feature.**

The issue's estimate is simply wrong: the selector axis is declared 21 times and rendered in 3 hand-written shell templates. That is arithmetic, not scope creep. But bundling it into one PR is a real defect, so this ships as **four PRs, in order, each independently mergeable and independently green**:

| PR    | Title                                                                        | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | ~Files |
| ----- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| **A** | `refactor(rfapps): split shell completion generators into per-shell modules` | Pure move of `actions/completion.ts` → `actions/completion/{index,bash,zsh,fish}.ts`. Zero behavior change. Pinned by the existing 794-line parity suite unchanged.                                                                                                                                                                                                                                                                                                                                                                  | 5      |
| **B** | `refactor(rfapps): unify service-selector predicates`                        | `lib/selector.ts` with `SelectorFlags`/`hasExplicitSelector`/`explicitSelectorFlagNames`; the six call-site replacements; the shared `ResolveServicesFn` replacing three duplicated DI signatures. **No `tag` field yet** — this is pure debt payoff with zero user-facing change, independently reviewable, and it is the seam #62 needs.                                                                                                                                                                                           | ~12    |
| **C** | `feat(rfapps): add hierarchical tag selector for service targeting`          | `types/tags.ts`, `lib/tags/**`, `TagSelectorEmptyError` + formatter, config plumbing, `validateTagReferences`/`validateTagLayerOwnership`, `tag` on `SelectorFlags`/`ServiceTargetOptions`, `applyTagAxis`, the resolver branch, `interactive-check`, `addServiceTargetOptions` applied to 21 commands, the `status` path, completion for 3 shells, specs 1–5 + extensions. **Must land atomically** — a partial merge leaves `--tag` on some commands and not others, which is exactly the accretion this design exists to prevent. | ~40    |
| **D** | `feat(rfapps): add rfapps tag list/show/suggest`                             | `commands/tag.ts`, `actions/tag.ts`, `actions/tag-suggest.ts`, `tag-inference*.ts`, specs 6 + 7, all docs, `ROADMAP.md`, `docs/plans/` pair                                                                                                                                                                                                                                                                                                                                                                                          | ~18    |

PRs A and B carry no user-facing change and can be reviewed in minutes. PR C is the irreducible core. PR D is additive.

### 13.3 "`--tag` on `status` costs a `docker compose ps` round-trip on the hottest command to solve a divergence that does not exist."

**Accepted and fixed.** `getServiceContainerMap` is dropped from scope (§7.9). `status --tag` filters on the service-key fallback alone. Measured: all 45 services declare `container_name` identical to the service key, zero exceptions. The divergent case is a documented limitation. If it is ever observed in the field, add the map then.

### 13.4 "`infrastructure/*` reaching the whole subtree is a trap that ships with only a doc paragraph as mitigation."

**Accepted and fixed.** Trailing `/*` is **rejected at parse time** with a corrective suggestion (§3.7). Interior `*` remains supported, because only in the trailing position does closure make it counterintuitive.

### 13.5 "`hasExplicitSelector`'s `services?: readonly string[]` does not typecheck at two of the six sites and changes `--services ''` behavior."

**Accepted and fixed.** `SelectorFlags.services` is `string | readonly string[]` (§4.2), because `cli.ts:234` and `commands/backup.ts:62` genuinely read raw comma-joined Commander strings. The `--services ""` change is deliberate, documented, and pinned by a test: `""` splits to zero names, so treating it as a target is a latent bug that today suppresses the deploy `--staged` preflight for a selector resolving to nothing.

### 13.6 "P3 asserts a safety property the design cannot deliver — a stale `tags.mapping` entry is filtered by the intersection and never reaches `validateServiceNames`."

**Accepted and fixed.** The false claim is removed; `TagIndex.unresolvedServices` replaces it (P4, §7.2), with a dedicated error message (§9.5) and a `ValidationWarning` surface. Separately, P3's _ordering_ is corrected: `validateServiceNames` runs on `NAMES ∪ GROUPS` **before** the intersection, so `-s plexx --tag "media/**"` yields `ServiceNotFoundError: did you mean plex?` rather than a misleading tag error.

### 13.7 "`Object.keys(config.tags.mapping)` yields service names, not tag values, so `--tag <TAB>` would complete service names."

**Accepted and fixed.** §9.6 specifies `Object.values(mapping).flat()` plus ancestor closure, sorted and deduped.

### 13.8 "The `--services` completion helper does comma-segment handling behind a hardcoded guard; a plain `compgen -W` arm gives wrong completions for `--tag`."

**Accepted and fixed.** §9.6 specifies the `${cur%,*}` / `${cur##*,}` idiom for bash, `_values -s ,` for zsh, and a `__rfapps_complete_tags` helper for fish, plus adding `--tag` to **both** value-taking-flag forms at `completion.ts:158` and `:161`.

### 13.9 "The design bundles two unrelated cross-cutting refactors into a feature PR."

**Accepted and fixed** by PR B in §13.2. Both refactors land alone, before the feature, with no behavior change.

### 13.10 "`--tag` means two opposite things — `status` intersects while resolver-backed commands union."

**Accepted and fixed by making everything intersect** (§7.3, §7.9). `--tag` narrows on every command without exception, and the flag help text says "Narrow." There is no divergence to document.

### 13.11 "Day-one value is near zero — `tag suggest`'s strongest rules re-encode `profiles.mapping` and `groups`, which the operator already has and can already select by."

**Partially accepted; not treated as fatal.** The measurement is right: `tag-infer-profile` covers 45/45 and `tag-infer-group` 43/45, so the offline baseline largely restates existing taxonomy. §8.4 says so in the design and the operator doc says so to the user rather than overclaiming.

What it misses is that the _cross-cutting_ facets are the point, and they are exactly what `groups:` structurally cannot express. Measured on this repo: 5 datastores (`authentik-db`, `authentik-redis`, `forgejo-postgres`, `immich-redis`, `immich-postgres`) span 3 different groups; 26 services carry `traefik.enable`; 5 carry docktail labels. Expressing "every datastore" or "everything behind Traefik" as a group means hand-listing them and hand-maintaining that list as services are added — which is precisely the drift a derived/authored tag facet avoids. Intersection makes composition possible in a way `-g` cannot: `rfapps stop -g media-stack --tag "data/**"` has no `-g` equivalent at all.

The design does not claim `--tag "media/**"` beats `-g media-stack` for the cases groups already handle. It claims multi-axis membership plus intersection plus prefix queries are new, and they are.

### 13.12 "Value-per-surface-area is poor: ~11 new files and ~40 modified for a filtering axis on a 45-service homelab."

**Rejected as a reason not to ship, accepted as a reason to sequence.**

The surface is dominated by two things that are not the feature: 21 Commander declarations (mechanical, one helper call each) and 3 hand-maintained shell templates with exact-parity tests. Both are fixed costs of _any_ new targeting flag in this codebase — #62's `--smart-group` will pay them again unless #63 pays them once and leaves `SelectorFlags` behind.

The genuine logic is ~600 lines across 5 focused modules, all under the 500-line cap, each with one reason to change. PR B specifically exists so that the debt payoff (six duplicated predicates, three duplicated DI signatures) lands whether or not the feature does.

A judge suggested a "flat, non-hierarchical `--tag`" 80% version at ~150 LOC. That is rejected: the issue is titled _Hierarchical_ Service Tagging, hierarchy is the DigiKam model it cites, ancestor closure is the single rule that makes hierarchy work, and the matcher it enables is 150 lines. Shipping flat tags and adding hierarchy later means re-deciding every semantic in this document under compatibility constraints.

### 13.13 "`-p/--profile` is a live footgun — compose.yml has zero `profiles:` keys, so `rfapps deploy -p media` deploys everything."

**Confirmed as a real bug, and explicitly out of scope for #63.**

The judge is right: `compose.yml` declares no `profiles:` keys, so `--profile media` passes `--profile media` to a profile-less compose file and Compose targets everything, while the operator believes they scoped it. That is worth fixing.

It is not this issue. Fixing it means either making `-p` a real targeting flag backed by `config.profiles.mapping` (changing the meaning of an existing flag across 12 commands and the MCP surface) or rejecting `-p` when compose declares no profiles (a behavior change on every existing invocation). Both deserve their own issue, their own design, and their own review. **A separate issue is filed**: `[rfapps-cli] --profile silently no-ops against a profile-less compose file`.

### 13.14 "Docs are named only as a delivery step; the operator contract, README anchor, and CLAUDE.md section are unspecified."

**Accepted and fixed.** §9.8 enumerates 14 documentation surfaces file-by-file, including the hardcoded command list in `shell-completion.md:114-123`, the `AGENTS.md` mirror, and the `rfapps-mcp-server.md` CLI-only note.

### 13.15 "The `rfapps tag` option surface is never specified, so the completion parity work cannot be written from the design."

**Accepted and fixed.** §6.1 gives the exact per-subcommand option table.

### 13.16 "The `--json`/`--output` formatter path is entirely absent, and `csv`/`table` behavior for nested tag output is undefined."

**Accepted and fixed.** §6.5 specifies `resolveHardenFormat` ordering (local `--json` before `globalOptions.output`, mandatory because `--output` has `.default("text")`), rejects `csv` for `tag list`/`tag show` following the `backup` precedent, and defines the flattened `table` columns.

### 13.17 "`TagSelectorEmptyError`'s formatter must be registered before the generic `InvalidArgumentError` block because `instanceof` ordering matters."

**Rejected — the claim is wrong and is corrected.** All 15 formatters in `error-formatters.ts` are `instanceof`-exact with no catch-all, and `TagSelectorEmptyError extends Error`, not `InvalidArgumentError`. Registration order is not load-bearing here; §9.5 says so.

### 13.18 "The design should introduce an rfapps-cli architecture-check script to keep glob logic out of actions."

**Rejected.** rfapps-cli has no ESLint and no architecture-check script; rfmedia-cli's `check-direct-plex-imports.mjs` is a bespoke one-rule guard wired into `prebuild`/`pretypecheck` hooks that rfapps-cli does not have. Introducing that machinery inside a feature PR is exactly the scope bundling §13.2 exists to prevent. The module boundary here is enforced by the barrel files and by review, as it is for every other rfapps-cli subsystem. If the package wants a guard, that is its own issue.
