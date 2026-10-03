# Design: Contextual Plan Intelligence (#152)

## Decision summary

`rfapps plan` today collapses five orthogonal diffs plus a five-valued registry status into one `ChangeType` string, then discards every signal that produced it. This design adds an **opt-in `--explain` pass** that emits a plan-level `plan.intelligence` payload carrying, per changed service, a ranked list of typed `ChangeReason` records (which dimension changed, which one _forced_ the change type, and — when a comparable prior plan exists — where the change originated) plus a declared-dependency `ServiceImpact`.

Decisions taken, with the judge disagreements they resolve:

| Decision                                                                                                                | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Annotations live at `DeploymentPlan.intelligence`, never on `ServiceChange`**                                         | `apply.ts:742`/`:759` writes `JSON.stringify(serviceChange)` into the SQLite `config_snapshot` column for every applied _and_ failed service, and `recordGeneration` mirrors that blob verbatim into the append-only `generations` table. Per-service annotations would grow state rows forever and nest an attribution payload inside the snapshot used for future attribution. All three judge panels agreed.                                                                                                                                                                                                                                                                                               |
| **One new flag: `--explain`** (opt-in, default off)                                                                     | Judges split. Decided **for** the flag: (a) it keeps the default `--output json` payload byte-identical, which is the strongest possible machine-contract story; (b) baseline loading is filesystem I/O and must not run on every `rfapps plan`, nor for `managed-update`/`doctor`, which also call `generatePlan`; (c) the existing global `-v/--verbose` then cleanly owns _depth_, which is exactly issue note #3. The nine-edit-site cost is real and is fully enumerated below.                                                                                                                                                                                                                          |
| **No state database in v1**                                                                                             | Design 2's state path was found unsound in three independent ways: `deploy`/`rebuild` (the dominant path) write only `{"image":"…"}`; `import`/`state rebuild` rows record observed reality that may never have matched compose, so "observed fingerprint unchanged ⇒ compose moved" is invalid; managed `update` writes a pre-flight generation with the _old_ image and no snapshot, which `MAX(generation)` silently promotes over a usable `apply` row; and eight actions call bare `initializeDatabase()` while a plan-time reader would use `getStateDbPath(config)`, so a custom `state.dbPath` makes every service falsely "never deployed". Excluded as an explicit non-goal with a follow-up issue. |
| **Baseline = the newest _scope-compatible_ saved plan, and provenance is always `inferred`**                            | The `composeHash` (raw file text) × `resolvedConfigFingerprint` (post-interpolation) correlation is the only cheap discriminator on disk, but it cannot be `confirmed`: the resolved model also moves on a different secrets tool (`--use-dotenvx`/`--use-op`), a Compose CLI upgrade, a different `--profile` set, or `include:`/multi-`-f` compose. Every provenance reason therefore ships at `confidence: "inferred"` with the alternatives named in its own summary string.                                                                                                                                                                                                                              |
| **Baseline selection is scope-gated**                                                                                   | `listPlans()` sorts every `plan-*.json` by mtime with no filtering, and `savePlan` runs on _every_ `rfapps plan`. Planning `-f compose.dev.yml` then `compose.yml` would otherwise compare one file's bytes against the other's hash and label every service `compose-file-edited`. The loader requires matching `composePath`, matching sorted `profiles`, non-`managed-update` intent, and a non-empty `composeHash`.                                                                                                                                                                                                                                                                                       |
| **`determineChangeType` is refactored to return `{ changeType, decisive }`**                                            | Both the classifier and the change-type cascade would otherwise encode the same priority rules in two places; a future sixth diff dimension would make the persisted `decisive` field lie while both modules' tests stay green. One cascade, one source of truth.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **`invertDependencyMap` is added to `dependency-graph.ts` and `staged-rollout.computeFanIn` is rewritten on top of it** | `computeFanIn` (staged-rollout.ts:60) already inverts a dependency map. A second private inverter is a straight DRY violation. The word "blast radius" stays reserved for `compareBlastRadius`'s rollout _ordering_; the plan feature says "impact" / "declare `depends_on`" and never re-ranks.                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Wording is deliberately weaker than the mechanism suggests**                                                          | `container-not-running`, not "service absent" (`docker compose ps --status running` cannot see a stopped or crash-looping container). "N services declare `depends_on` X", not "N services will break" (Compose does not restart dependents). "the locally cached image for this reference is behind the registry", not "the running container is behind" (`checkImageUpdate` compares the local daemon cache).                                                                                                                                                                                                                                                                                               |

Issue-note coverage: **#1 classify by source** → `ChangeReasonKind` (`trigger`/`provenance`/`advisory`) × the reason codes, spanning runtime, declaration, and registry axes; **#2 blast radius** → `ServiceImpact` with declared-dependency closure and running-dependent count; **#3 concise by default + verbose** → one `why:` line (+ one conditional `impact:` line) by default, full reason blocks under `-v`; **#4 stable JSON schema** → exactly one additive optional key on `DeploymentPlan`, mirrored into `src/mcp/schema.ts` with a runtime round-trip test.

---

## Data model (concrete TypeScript)

### `src/types/plan-intelligence.ts` (new, ~165 lines, contracts only — must not import from `src/lib/*`)

```ts
/**
 * Contracts for contextual plan annotations (issue #152).
 *
 * These types are serialized into saved plans and into the `rfapps.plan` MCP
 * result, so every addition must be mirrored in `src/mcp/schema.ts`.
 */

/** Versioned marker for the annotation payload. Mirrors the RECONCILE_SCHEMA_VERSION idiom. */
export const PLAN_INTELLIGENCE_SCHEMA_VERSION = "plan-intelligence.v1" as const;

/** Maximum reasons retained per service. */
export const MAX_CHANGE_REASONS = 8;
/** Maximum evidence strings retained per reason. */
export const MAX_REASON_EVIDENCE = 6;
/** Maximum dependent names listed per service. */
export const MAX_IMPACT_DEPENDENTS = 10;
/** Maximum changing-dependency names listed per service. */
export const MAX_CHANGING_DEPENDENCIES = 6;
/** Newest saved plans examined when searching for a scope-compatible baseline. */
export const MAX_BASELINE_CANDIDATES = 10;

/**
 * Stable reason identifiers.
 *
 * Declared as a tuple so `ChangeReasonCode` and the MCP `schemaEnum` are
 * derived from ONE list; adding a code without updating the schema is then a
 * compile error rather than a runtime `No union variant matched at $`.
 */
export const CHANGE_REASON_CODES = [
  // trigger -- explains `ServiceChange.changeType`
  "container-not-running",
  "image-reference-changed",
  "environment-changed",
  "ports-changed",
  "volumes-changed",
  "networks-changed",
  // provenance -- explains where the change originated (needs a baseline)
  "compose-file-edited",
  "resolved-config-changed",
  "unchanged-since-baseline",
  // advisory -- notable, never drives `changeType`
  "registry-image-drifted",
] as const;

export type ChangeReasonCode = (typeof CHANGE_REASON_CODES)[number];

/** What a reason explains. */
export type ChangeReasonKind = "trigger" | "provenance" | "advisory";

/**
 * How firmly a reason is established.
 *
 * `confirmed` -- two observed values were compared directly.
 * `inferred`  -- partial evidence that cannot exclude an alternative cause;
 *                the alternatives are always named in `summary`.
 */
export type ReasonConfidence = "confirmed" | "inferred";

/**
 * One ranked explanation.
 *
 * Deliberately a flat record with a literal-union `code` rather than a
 * ten-variant payload union: `schemaUnion` failures report only
 * `No union variant matched at $`, which would make schema drift undebuggable.
 */
export interface ChangeReason {
  /** Stable machine-readable identifier. */
  code: ChangeReasonCode;
  /** Whether this explains the change type, its origin, or is advisory. */
  kind: ChangeReasonKind;
  /** Whether the reason was proven by direct comparison or inferred. */
  confidence: ReasonConfidence;
  /**
   * True when this dimension alone forced `ServiceChange.changeType` under the
   * `determineChangeType` cascade. Always false for provenance and advisory.
   */
  decisive: boolean;
  /** Canned operator sentence. Never interpolated with a resolved config value. */
  summary: string;
  /**
   * Bounded, secret-free facts: environment variable NAMES, image references,
   * hash/digest prefixes, service names, ISO timestamps. Never values.
   */
  evidence: string[];
}

/** What applying this service's change does to its container. */
export type ServiceEffect =
  /** Nothing is applied for this service. */
  | "none"
  /** No container exists; one is created. */
  | "create"
  /** The running container is stopped and replaced (update, recreate, delete). */
  | "replace";

/** Declared-dependency impact. Derived from Compose only; no state, no Docker calls. */
export interface ServiceImpact {
  /** Effect on this service's own container. */
  effect: ServiceEffect;
  /** True when `profiles.mapping[service] === "core"`. */
  critical: boolean;
  /**
   * Size of the transitive set of services that declare `depends_on` (or
   * `network_mode: service:`) onto this one, excluding itself.
   *
   * Compose `depends_on` governs start ordering, NOT runtime coupling: these
   * services are not restarted by `rfapps apply`.
   */
  dependentCount: number;
  /** Sorted sample of that set, capped at `MAX_IMPACT_DEPENDENTS`. */
  dependents: string[];
  /** True when `dependents` omits names beyond the cap. */
  dependentsTruncated: boolean;
  /** Subset of the transitive set that currently has a running container. */
  runningDependentCount: number;
  /** Direct dependencies that this plan also replaces, sorted, capped. */
  changingDependencies: string[];
}

/** Annotations for one service. */
export interface ServiceIntelligence {
  /** Ranked reasons, decisive triggers first. Never empty. */
  reasons: ChangeReason[];
  /** Declared-dependency impact. */
  impact: ServiceImpact;
}

/** Why no usable baseline was found. */
export type BaselineUnavailableReason =
  /** No saved plan matched this compose path and profile set. */
  | "no-comparable-plan"
  /** The plan directory could not be read. */
  | "plan-history-unreadable";

/** How change origin was resolved for this plan. */
export type PlanProvenance =
  | {
      /** Discriminant */
      baseline: "none";
      reason: BaselineUnavailableReason;
    }
  | {
      /** Discriminant */
      baseline: "previous-plan";
      /** `DeploymentPlan.id` of the baseline. */
      planId: string;
      /** ISO 8601 `createdAt` of the baseline. */
      createdAt: string;
      /** True when the compose file's current text differs from the baseline `composeHash`. */
      composeFileChanged: boolean;
    };

/** Plan-wide rollup. */
export interface PlanIntelligenceSummary {
  /** Services carrying at least one reason. */
  annotatedServices: number;
  /**
   * Distinct services that transitively declare `depends_on` a service whose
   * `effect` is not `none`, EXCLUDING services that are themselves changing.
   * Computed as a set difference, so it can never be negative.
   */
  downstreamImpacted: number;
  /** Annotated services mapped to the `core` profile. */
  criticalServices: number;
  /** Most frequent reason code across annotated services, when one exists. */
  dominantReason?: ChangeReasonCode;
}

/** Contextual annotations attached to a deployment plan. Present only with `--explain`. */
export interface PlanIntelligence {
  /** Versioned contract marker. */
  schemaVersion: typeof PLAN_INTELLIGENCE_SCHEMA_VERSION;
  /** How change origin was resolved. */
  provenance: PlanProvenance;
  /** True when `--check-updates` ran; false means registry drift was NOT evaluated. */
  registryChecked: boolean;
  /**
   * False when `docker compose ps` failed and no runtime state could be
   * observed. All `container-not-running` reasons are suppressed in that case.
   */
  runtimeStateObserved: boolean;
  /** Annotations keyed by service name. Only services with at least one reason appear. */
  services: Record<string, ServiceIntelligence>;
  /** Plan-wide rollup. */
  summary: PlanIntelligenceSummary;
}

// ---------------------------------------------------------------------------
// Inputs. Never serialized into a plan, so `readonly` is safe here.
// ---------------------------------------------------------------------------

/** Baseline facts for one service, lifted from a prior saved plan. */
export interface PlanBaselineService {
  /** `ServiceChange.resolvedConfigFingerprint` from the baseline plan (64 hex). */
  readonly resolvedConfigFingerprint: string;
}

/** A scope-compatible prior plan used for change-origin attribution. */
export interface PlanBaseline {
  readonly planId: string;
  readonly createdAt: string;
  /** True when the compose file's current text differs from the baseline `composeHash`. */
  readonly composeFileChanged: boolean;
  readonly services: Readonly<Record<string, PlanBaselineService>>;
}

/** Result of attempting to load a baseline. Always resolves; never throws. */
export type PlanBaselineResult =
  | { /** Discriminant */ status: "loaded"; baseline: PlanBaseline }
  | { /** Discriminant */ status: "unavailable"; reason: BaselineUnavailableReason };

/** Caller-supplied enrichment. Presence of this object is what enables annotation. */
export interface PlanIntelligenceInput {
  /** `RfappsConfig.profiles.mapping`, for the `core` criticality tier. */
  readonly profileMapping: Readonly<Record<string, string>>;
  /** Change-origin baseline. */
  readonly baseline: PlanBaselineResult;
}
```

### `src/types/plan.ts` (modified, +6 lines)

```ts
import type { PlanIntelligence, PlanIntelligenceInput } from "./plan-intelligence.js";

export interface DeploymentPlan {
  // ... every existing field unchanged ...
  /** Contextual annotations. Absent unless `--explain` was requested. */
  intelligence?: PlanIntelligence;
}

export interface PlanOptions {
  // ... every existing field unchanged ...
  /** Enrichment for contextual annotations. Absent => no annotation is computed. */
  intelligence?: PlanIntelligenceInput;
}
```

### `src/lib/dependency-graph.ts` (modified, +~18 lines)

```ts
/**
 * Invert a forward dependency map into `service -> services that depend on it`.
 *
 * Shared by staged rollout (fan-in counts) and plan intelligence (dependent
 * names + transitive closure) so both agree on what an edge is.
 *
 * @param dependencyMap - forward map from `buildServiceDependencyGraph`
 * @returns code-point-sorted dependent lists; pure, no I/O
 */
export function invertDependencyMap(
  dependencyMap: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, readonly string[]>;
```

`staged-rollout.ts`'s private `computeFanIn` becomes a five-line derivation over `invertDependencyMap(...)`; `compareBlastRadius` and `criticalityTier` are untouched.

### `src/lib/plan-generator.ts` (modified, ~+40 lines)

```ts
/** Diff dimension that can force a change type. */
type ChangeDimension = "runtime" | "image" | "environment" | "ports" | "volumes" | "networks";

/**
 * Determine change type and record which dimensions forced it.
 *
 * Returning `decisive` makes the plan-intelligence classifier read the cascade's
 * verdict instead of re-implementing it.
 */
function determineChangeType(/* same six params */): {
  changeType: ChangeType;
  decisive: readonly ChangeDimension[];
};
```

`generatePlan` accumulates `decisiveByService: Map<string, readonly ChangeDimension[]>` and, immediately before building the returned plan object (after the `checkUpdates` pass, after `summary`), does:

```ts
if (options.intelligence !== undefined) {
  plan.intelligence = buildPlanIntelligence({
    services,
    decisiveByService,
    composeServices,
    runningServices: new Set(containerMap.keys()),
    runtimeStateObserved: serviceContainerMap !== undefined,
    registryChecked: options.checkUpdates === true,
    profileMapping: options.intelligence.profileMapping,
    baseline: options.intelligence.baseline,
  });
}
```

### `src/lib/plan-intelligence.ts` (new, ~330 lines, PURE)

```ts
export interface PlanIntelligenceBuildInput {
  readonly services: readonly ServiceChange[];
  readonly decisiveByService: ReadonlyMap<string, readonly ChangeDimension[]>;
  /** `ComposeConfig.services` already in `generatePlan` scope. */
  readonly composeServices: Readonly<Record<string, ComposeServiceConfig>>;
  /** Compose services with a running container at plan time. */
  readonly runningServices: ReadonlySet<string>;
  /** False when `docker compose ps` failed. */
  readonly runtimeStateObserved: boolean;
  /** True when `--check-updates` ran. */
  readonly registryChecked: boolean;
  readonly profileMapping: Readonly<Record<string, string>>;
  readonly baseline: PlanBaselineResult;
}

/**
 * Derive contextual annotations from data the plan generator already holds.
 *
 * PURE: no I/O, no logging, no `process.exitCode`, never mutates `input`.
 * Traversal is cycle-safe via a visited set.
 */
export function buildPlanIntelligence(input: PlanIntelligenceBuildInput): PlanIntelligence;
```

### `src/lib/plan-baseline.ts` (new, ~110 lines — the ONLY I/O)

```ts
/**
 * Find the newest saved plan usable as a change-origin baseline.
 *
 * A candidate qualifies only when it targets the SAME compose file with the
 * SAME profile set: `listPlans()` is mtime-ordered with no filtering and
 * `savePlan` runs on every `rfapps plan`, so an unfiltered "newest" would
 * compare one compose file's bytes against another file's hash.
 *
 * Best effort: every failure resolves to `{ status: "unavailable", ... }`.
 * Never throws, never logs above `logDebug`.
 *
 * @param composePath - compose file the current plan targets
 * @param profiles - resolved profiles for the current plan
 */
export async function loadPlanBaseline(composePath: string, profiles: readonly string[]): Promise<PlanBaselineResult>;
```

### `src/lib/formatters/plan-intelligence.ts` (new, ~120 lines, PURE)

```ts
/** Concise (1-2) or verbose stderr lines for one service, without leading indent. */
export function formatServiceIntelligenceLines(
  intelligence: ServiceIntelligence | undefined,
  options: { verbose: boolean },
): string[];

/** Plan-level provenance, registry-drift section, and rollup lines. */
export function formatPlanIntelligenceLines(
  intelligence: PlanIntelligence | undefined,
  services: readonly ServiceChange[],
  options: { verbose: boolean },
): string[];
```

---

## Derivation rules (per reason kind, with inputs and degradation)

All inputs are already in `generatePlan`'s memory except the baseline. **Zero new Docker subprocesses. Zero second `getComposeConfig()` call.**

### Global suppression rules (checked before any reason is emitted)

| Condition                                                                               | Behaviour                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `options.intelligence === undefined`                                                    | No `plan.intelligence` key at all. Byte-identical to today.                                                                                                                                                                                                                                                                                                 |
| `runtimeStateObserved === false` (`getRunningServiceContainerMap` returned `undefined`) | **All `container-not-running` reasons suppressed.** Every service falsely reports `changeType: "create"` in that state today; asserting a cause for state we never observed is the worst failure mode this feature can have. `plan.intelligence.runtimeStateObserved` is `false` and the renderer prints one banner line instead of 47 confident sentences. |
| `registryChecked === false`                                                             | No `registry-image-drifted` reason is ever emitted, and the renderer prints `registry drift not checked (add --check-updates)`.                                                                                                                                                                                                                             |
| A service ends with `reasons.length === 0`                                              | Omitted from `intelligence.services` entirely. Presence is meaningful.                                                                                                                                                                                                                                                                                      |

### Trigger reasons — explain `changeType`

Emitted from `decisive` (returned by `determineChangeType`) plus the raw diffs. `decisive: true` iff the dimension appears in that array.

| Code                      | Emitted when                                             | Confidence  | Evidence (bounded)                                                                                              |
| ------------------------- | -------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------- |
| `container-not-running`   | `changeType === "create"` **and** `runtimeStateObserved` | `confirmed` | none                                                                                                            |
| `image-reference-changed` | `image.changed === true`                                 | `confirmed` | `current=<ref>`, `desired=<ref>`                                                                                |
| `environment-changed`     | any `EnvChange.changeType !== "unchanged"`               | `confirmed` | variable **NAMES + change type** only (`PLEX_CLAIM (modified)`), capped at `MAX_REASON_EVIDENCE` with `+N more` |
| `ports-changed`           | `ports.changed`                                          | `confirmed` | `host:container/proto` strings                                                                                  |
| `volumes-changed`         | `volumes.changed`                                        | `confirmed` | `source:target[:ro]` strings                                                                                    |
| `networks-changed`        | `networks.changed`                                       | `confirmed` | network names                                                                                                   |

**Create-suppression rule (mandatory).** When `changeType === "create"`, ONLY `container-not-running` is emitted. For a non-running service `currentImage`/`currentEnv`/`currentPorts`/`currentVolumes` are all `undefined`, so `createImageDiff(undefined, X).changed` is trivially `true` and `compareEnv(undefined, d)` marks every declared variable `added`. Without this rule every first deploy carries five vacuous triggers.

**Multi-cause is first class.** A `recreate` emits `image-reference-changed` (`decisive: true`) **plus** every concurrently changed declaration dimension (`decisive: false`). This is net-new: today a recreate visually hides a simultaneous env or volume change. An `update` emits each changed dimension at `decisive: true`.

**`environment-changed` carries NAMES only, never values.** `isSecretEnvVar` is an 11-keyword substring heuristic that misses `SESSION_ID`, `WEBHOOK_URL`, etc.; gating a brand-new output surface on a heuristic creates an unauditable leak path. Names are already present verbatim as `EnvChange.name` in the same plan file, so this widens nothing.

**`networks-changed` is naturally silent for shared namespaces**: `plan-generator.ts` forces both sides to `undefined` when `network_mode` or a `container:`/`service:` NetworkMode is in play, so `changed === false`.

### Provenance reasons — explain origin (require a baseline)

Let `prev = baseline.services[service]?.resolvedConfigFingerprint`, `now = change.resolvedConfigFingerprint`, `edited = baseline.composeFileChanged`.

| `baseline.status` | `prev`              | `prev` vs `now` | `edited` | Emitted                                                                                    | Confidence     |
| ----------------- | ------------------- | --------------- | -------- | ------------------------------------------------------------------------------------------ | -------------- |
| `unavailable`     | —                   | —               | —        | _(nothing; `provenance.baseline === "none"`)_                                              | —              |
| `loaded`          | absent / not 64-hex | —               | —        | _(nothing — the service is new since the baseline, or the baseline predates fingerprints)_ | —              |
| `loaded`          | present             | equal           | any      | `unchanged-since-baseline`                                                                 | `confirmed`    |
| `loaded`          | present             | differ          | `true`   | `compose-file-edited`                                                                      | **`inferred`** |
| `loaded`          | present             | differ          | `false`  | `resolved-config-changed`                                                                  | **`inferred`** |

Why `inferred` in both moved cases — the alternatives are named in each `summary`:

- `compose-file-edited`: the file's text genuinely changed (SHA-256 of `plan.composePath`), but attributing _this service's_ fingerprint move to that edit cannot exclude a simultaneous environment change. `hashFile` also covers only the top-level compose path — not `include:` files, not additional `-f` overrides, not the env file.
- `resolved-config-changed`: the compose file text is identical yet the post-interpolation model moved. Likely an environment variable or `--env-file` change — but a different secrets tool (`--use-dotenvx` vs `--use-op` vs none), a Docker Compose CLI upgrade that renormalizes `docker compose config` output, or a different active profile set produce the same signal. The summary reads: _"resolved config changed with `compose.yml` unchanged — likely an environment or secrets-tool input; a Compose CLI upgrade produces the same signal"_.
- `unchanged-since-baseline` is `confirmed` (both hashes equal) and answers a real question: _"this change was already pending when you last planned; you did not just cause it."_

**Baseline eligibility (all four required).** Scanning the newest `MAX_BASELINE_CANDIDATES = 10` entries of `listPlans()` in order, the first candidate satisfying all of these wins:

1. `plan.intent !== "managed-update"` (absent or `"deployment"`).
2. `plan.composePath === composePath` of the current run.
3. `[...plan.profiles ?? []].sort()` deep-equals `[...profiles].sort()`.
4. `plan.composeHash` is a non-empty string.

Then `composeFileChanged = (await hashFile(composePath)) !== plan.composeHash`, and the per-service map keeps only 64-hex `resolvedConfigFingerprint` values. No other field is lifted out of a prior plan — critically, **no `EnvChange` value ever crosses this boundary**, since saved plans persist resolved secrets unmasked.

### Advisory reason

| Code                     | Emitted when                                                                                            | Confidence  | Evidence                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------- |
| `registry-image-drifted` | `registryChecked` **and** `image.changed === false` **and** `image.updateStatus === "update-available"` | `confirmed` | `canonicalImage`, 19-char prefixes of `localDigest` / `remoteDigest` |

Discriminates on the five-valued `ImageUpdateStatus`, **never** on the retained-for-compat `updateAvailable` boolean, so `unsupported` (build-only), `unknown`, and `local-missing` can never render as "a newer version is available". Wording is _"the locally cached image for this reference is behind the registry"_ because `checkImageUpdate` compares `getLocalImageDigest(desiredRef)` (local daemon cache) against the remote manifest, not the running container.

**These services are annotated even though `changeType === "unchanged"`.** An entry exists iff `reasons.length > 0`, not iff the service is changing. This is what makes registry drift reachable — such services are otherwise invisible in default text output, which only iterates the create/recreate/update/delete buckets.

### Floating tags — explicit degradation

A floating tag (`:latest`, `:stable`) makes `image.changed === false` even when the upstream digest moved, because `createImageDiff` compares reference strings. Behaviour:

- **Without `--check-updates`**: no registry claim of any kind is made, `registryChecked: false`, and the renderer prints `registry drift not checked (add --check-updates)`. The tool never says "up to date".
- **With `--check-updates`**: the drift surfaces as `registry-image-drifted` on an `unchanged` service, which is the honest classification — the declaration did not change; the registry did.

### Ranking

Sort ascending by `[kindRank, decisiveRank, codeIndex]` where `kindRank` is `trigger=0, provenance=1, advisory=2`, `decisiveRank` is `0` for `decisive: true` else `1`, and `codeIndex` is the position in `CHANGE_REASON_CODES` (whose trigger ordering mirrors the `determineChangeType` cascade). Fully deterministic — codes are unique per service. Truncated at `MAX_CHANGE_REASONS`.

### Plan-level summary

`annotatedServices` = `Object.keys(services).length`. `criticalServices` = annotated services with `impact.critical`. `dominantReason` = most frequent code, ties broken by `codeIndex`.

`downstreamImpacted` is a **set difference, never a subtraction**:

```
changing   = { s | intelligence.services[s].impact.effect !== "none" }
reached    = union over changing of transitiveDependents(s)
downstreamImpacted = |reached \ changing|
```

A plan that replaces two leaf services yields `reached = {}` and `downstreamImpacted = 0`. The naive `|reached| - |changing|` form goes negative in exactly that (modal) case and would fail the MCP schema's `schemaNumber({ integer: true, minimum: 0 })` with an unnameable union error.

---

## Blast radius model

Called `impact` throughout — `blastRadius` remains reserved for `staged-rollout.compareBlastRadius`, which stays the sole authority for rollout **ordering**. Plan intelligence reports reach and never re-ranks.

**Graph construction.** Inside `buildPlanIntelligence`:

```ts
const forward = buildServiceDependencyGraph(
  { services: composeServices },
  {}, // sidecar merge: see note below
  Object.keys(composeServices), // ALL services, never the plan target subset
);
const dependents = invertDependencyMap(forward);
```

- **All service keys, never `options.services`.** `buildServiceDependencyGraph` filters dependencies to the target set in its final step, so inverting a target-scoped map silently under-reports dependents — precisely the failure this metric exists to prevent.
- **`{}` sidecar mapping.** This deployment has `sidecars.enabled: false` and an empty mapping, so the merge step is a no-op; passing `{}` keeps `buildPlanIntelligence` pure (no `RfappsConfig` dependency) and matches the current runtime. Documented limitation: with `sidecars.enabled: true`, plan impact would omit sidecar-propagated edges that `deploy` would honour. Noted in the feature doc and the risk list.
- **Edge sources** are exactly what `buildServiceDependencyGraph` already extracts: `depends_on` (both YAML forms, via `getComposeServiceDependencies`) and implicit `network_mode: service:<X>`. `depends_on` **conditions** (`service_healthy` vs `service_started`) are flattened by that seam and are weighted identically — documented, not worked around.

**Per-service derivation.**

| Field                   | Rule                                                                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effect`                | `unchanged` → `none`; `create` → `create`; `update`/`recreate`/`delete` → `replace`. `update` is **not** called "in place": Compose replaces the container for any config change.                               |
| `dependentCount`        | Size of the transitive upward closure via BFS over `dependents` with a `Set` visited guard (cycles are a first-class, already-tested condition elsewhere; an unguarded traversal hangs the CLI), seed excluded. |
| `dependents`            | Sorted closure, sliced to `MAX_IMPACT_DEPENDENTS`.                                                                                                                                                              |
| `dependentsTruncated`   | closure size > cap.                                                                                                                                                                                             |
| `runningDependentCount` | closure ∩ `runningServices`. A stopped dependent is not disrupted.                                                                                                                                              |
| `changingDependencies`  | Direct dependencies of this service that are in this plan's change set with `effect === "replace"`, sorted, capped. Surfaces an ordering hazard.                                                                |
| `critical`              | `profileMapping[service] === "core"` — the same tier predicate `criticalityTier` uses, so plan and staged rollout agree on "critical".                                                                          |

**Signals deliberately excluded.**

- **Shared network membership.** All 44 services that declare `networks:` join the single `apps` network. Grouping by it marks every service as impacting every other — pure noise that would destroy trust in the whole annotation set on day one.
- **Shared bind mounts.** Real but sparse, and correct detection needs subpath containment over interpolated absolute paths (`${DATA_DIR}` in 5 services overlaps `${DATA_DIR}/media` in 6), plus an O(n²) pass with the `EvaluationBudget` machinery. Deferred.

**Honest framing is a hard requirement.** In this repo only 11 of 48 services have any dependent (hubs: `forgejo` 4, `sabnzbd` 4, `nzbget` 4, `authentik-db`/`authentik-redis` 3). The `impact:` line is **omitted entirely when `dependentCount === 0`** rather than printing a reassuring zero, and the wording is _"N services declare depends_on X"_, never _"N services will break"_ — Compose does not restart dependents, and `apply` deploys only the plan's own change set.

**Profile-scoping caveat.** `composeServices` comes from `getComposeConfig(..., { profiles })`, which forwards `--profile` to Compose. Today `compose.yml` declares zero service-level `profiles:` keys, so the flag is inert and `composeServices` is every service. If profiles are ever adopted, dependents outside the active profiles become invisible. Documented on the `dependentCount` JSDoc, in the feature doc, and in the risk list.

---

## CLI surface & rendering (default vs verbose, with sample output)

### Flag

One new plan-only boolean, registered in `src/cli.ts` immediately after `--check-updates`:

```ts
.option("--explain", "Annotate changes with likely cause and dependency impact", false)
```

`--explain` selects the **data**; the existing global `-v/--verbose` selects the **depth** (issue note #3). `--explain` pairs naturally with `--check-updates` but does not imply it — registry checking must stay strictly opt-in because it costs a `docker image inspect` plus a `docker manifest inspect` per unique image/platform.

`--explain` mutates nothing, so `resolveStateLockOperation` is unchanged (plan still takes the state lock only under `--apply`). No cross-flag validation is needed, so no `preAction` hook change.

### Plumbing (`src/actions/plan.ts`)

`RawPlanOptions` and the normalized `PlanOptions` each gain `explain`. The generator call **conditionally spreads** so the non-explain path stays byte-identical (this is what keeps `plan.spec.ts:167-175`'s exact-literal assertion passing unchanged):

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

All human rendering stays on stderr via `console.error`; stdout remains reserved for the machine payload.

### Default output (`rfapps plan --explain`)

`displayServiceChange` prepends at most two lines before the existing diff block.

```
~ recreate  plex
  why: image reference changed (forces recreate); environment also differs
  impact: replaces plex; 4 services declare depends_on plex (3 running)
  image: - lscr.io/linuxserver/plex:1.40.2 → + lscr.io/linuxserver/plex:1.41.0
  environment:
    PLEX_CLAIM: - ******** → + ********

! update    authentik-server
  why: resolved config changed since plan 8f3a2c11 (2h ago), compose.yml unchanged
       — likely an environment or secrets-tool input [inferred]
  impact: replaces authentik-server; 3 services declare depends_on authentik-server (3 running)
  environment:
    AUTHENTIK_SECRET_KEY: - ******** → + ********

+ create    praxrr
  why: no running container found (a stopped container is not inspected)
```

Concise `why:` construction, prescriptively:

1. Lead clause = the **provenance** reason's summary if one exists, else the top-ranked **trigger** summary with `(forces <changeType>)` appended when `decisive`.
2. Optional second clause, joined by `"; "`:
   - if the lead was provenance → the decisive trigger dimensions, abbreviated (`environment, volumes differ`);
   - if the lead was a trigger → non-decisive dimensions (`environment also differs`), or nothing.
3. Space-prefixed suffix `[inferred]` when the lead reason's confidence is `inferred`.
4. `impact:` line is emitted **only when `dependentCount > 0`**.
5. `praxrr` above shows the create-suppression rule: exactly one reason, no `impact:` line.

New registry-drift section, printed under `--explain` even without `--show-unchanged` (these services are `unchanged` and otherwise never named):

```
Registry drift (compose unchanged, upstream image moved):
  radarr    docker.io/linuxserver/radarr:5.4   sha256:9c1f2e4a8b3d → sha256:31a0be77cc12
  tautulli  docker.io/tautulli/tautulli:v2.14  sha256:0d71ac4419e2 → sha256:c8e5f0a71b64
```

Summary block gains up to three lines:

```
Summary:
  + 1 to create
  ~ 1 to recreate
  ! 1 to update
  = 45 unchanged
  ^ 2 updates available
  → 5 downstream services declare depends_on a changing service

Change origin: compose.yml unchanged since plan 8f3a2c11 (2026-07-28T09:14:02Z)
```

Degraded variants (one line each, never per-service noise):

```
Change origin: unavailable (no prior plan for this compose file and profile set)
Registry drift not checked (add --check-updates)
Runtime state unavailable (docker compose ps failed); cause annotations suppressed
```

### Verbose output (`rfapps plan --explain -v`)

```
~ recreate  plex
  why:
    - image reference changed  [trigger/confirmed/forces recreate]
        current=lscr.io/linuxserver/plex:1.40.2
        desired=lscr.io/linuxserver/plex:1.41.0
    - environment changed  [trigger/confirmed]
        PLEX_CLAIM (modified)
        TZ (modified)
        VERSION (added)
    - compose.yml was edited since the baseline plan  [provenance/inferred]
        baseline plan 8f3a2c11 (2026-07-28T09:14:02Z)
        compose sha256 4b1e9c0a1f22 → 7d2f11ab903e
        a simultaneous environment change cannot be excluded
  impact:
    effect: replaces the running container
    core service: no
    dependents: 4 declared (3 running) — kometa, plexseerr, requestrr, tautulli
    changing dependencies: (none)
  image: - lscr.io/linuxserver/plex:1.40.2 → + lscr.io/linuxserver/plex:1.41.0
  ...
```

Truncation is explicit: `dependents: 14 declared (9 running) — a, b, c, d, e, f, g, h, i, j (+4 more)`.

### Non-text formats

`--output json` / `yaml` carry `plan.intelligence`. `actions/plan.ts` gains `planResultForOutput(format, payload)` mirroring `deployResultForOutput` (deploy.ts:159-167): it strips `plan.intelligence` for `table` and `csv` only. This does **not** fix `--output csv`, which already throws today (`flattenObject` `MAX_DEPTH = 2` vs `plan.summary` at depth 2) — it only guarantees the new payload does not deepen an already-broken path, and does not stringify a large nested object into one truncated table cell. The MCP capture path is unaffected because `buildGlobalOptions` hard-codes `output: "json"`.

---

## JSON / machine contract & compatibility

Two surfaces with asymmetric enforcement. The `--output json` stdout payload is the **hard** contract: it is verbatim the MCP `rfapps.plan` result (harvested by `withFormatOutputCapture`) and `createMcpToolRegistry.execute` runs `tool.outputSchema.parse(rawResult)` at runtime, where `schemaObject` defaults `additionalProperties: false`. The saved `.rfapps/plans/plan-*.json` file is the **soft** contract: `loadPlan` is a bare `readFile` + `JSON.parse` + unchecked cast and `validatePlan` inspects only `id`, `composePath`, `services.length`, `composeHash`, and 24 h age.

**Exactly one additive key**: `DeploymentPlan.intelligence?: PlanIntelligence`. Nothing is renamed, removed, or retyped. `planPath` and `plan` remain the only envelope keys.

### Mandatory `src/mcp/schema.ts` edits (same commit)

Omitting these makes **every** `rfapps.plan` MCP call fail with the unnameable `No union variant matched at $`, because the plan output is wrapped in `withDryRun(...) = schemaUnion([...])`.

```ts
import { CHANGE_REASON_CODES, PLAN_INTELLIGENCE_SCHEMA_VERSION } from "../types/plan-intelligence.js";

const changeReasonSchema = schemaObject({
  code: schemaEnum(CHANGE_REASON_CODES), // derived from ONE tuple; no hand-copied list
  kind: schemaEnum(["trigger", "provenance", "advisory"] as const),
  confidence: schemaEnum(["confirmed", "inferred"] as const),
  decisive: schemaBoolean(),
  summary: schemaString(),
  evidence: schemaArray(schemaString()),
});

const serviceImpactSchema = schemaObject({
  effect: schemaEnum(["none", "create", "replace"] as const),
  critical: schemaBoolean(),
  dependentCount: schemaNumber({ integer: true, minimum: 0 }),
  dependents: schemaArray(schemaString()),
  dependentsTruncated: schemaBoolean(),
  runningDependentCount: schemaNumber({ integer: true, minimum: 0 }),
  changingDependencies: schemaArray(schemaString()),
});

const planIntelligenceSchema = schemaObject({
  schemaVersion: schemaEnum([PLAN_INTELLIGENCE_SCHEMA_VERSION] as const),
  provenance: schemaUnion([
    schemaObject({
      baseline: schemaEnum(["none"] as const),
      reason: schemaEnum(["no-comparable-plan", "plan-history-unreadable"] as const),
    }),
    schemaObject({
      baseline: schemaEnum(["previous-plan"] as const),
      planId: schemaString(),
      createdAt: schemaString(),
      composeFileChanged: schemaBoolean(),
    }),
  ]),
  registryChecked: schemaBoolean(),
  runtimeStateObserved: schemaBoolean(),
  services: schemaRecord(
    schemaObject({
      reasons: schemaArray(changeReasonSchema),
      impact: serviceImpactSchema,
    }),
  ),
  summary: schemaObject({
    annotatedServices: schemaNumber({ integer: true, minimum: 0 }),
    downstreamImpacted: schemaNumber({ integer: true, minimum: 0 }),
    criticalServices: schemaNumber({ integer: true, minimum: 0 }),
    dominantReason: schemaOptional(schemaEnum(CHANGE_REASON_CODES)),
  }),
});

// deploymentPlanSchema gains exactly one key:
//   intelligence: schemaOptional(planIntelligenceSchema),
// planInputSchema gains:
//   explain: schemaOptional(schemaBoolean()),
// _typeCheck gains:
//   planIntelligence: McpSchema<PlanIntelligence>,
```

`serviceChangeSchema`, `planSummarySchema`, and `planResultSchema` are **unchanged**.

**`dominantReason` must be `schemaEnum(CHANGE_REASON_CODES)`, not `schemaString()`.** `schemaOptional(schemaString())` infers `string | undefined`, which is not assignable to `ChangeReasonCode | undefined`, and `McpSchema<T>` is covariant — the `_typeCheck` anchor would fail to compile, and "fixing" it by dropping the anchor would publish an unconstrained string to MCP clients.

**The `_typeCheck` anchor alone is insufficient** and this is why test T6 is not optional: `McpSchema<TValue>` exposes `TValue` only in return position, so a schema that _omits_ an optional field still satisfies `McpSchema<PlanIntelligence>`. `npm run typecheck` cannot catch a missing optional field; only a runtime round-trip of a real `buildPlanIntelligence(...)` output can.

### MCP input mirror (three sites, all mandatory)

- `src/mcp/schema.ts` — `PlanToolArgs` gains `explain?: boolean`
- `src/mcp/schema.ts` — `planInputSchema` gains `explain: schemaOptional(schemaBoolean())`
- `src/mcp/adapters.ts` — `invokePlan` passes `explain: args.explain`

### Versioning

`PLAN_INTELLIGENCE_SCHEMA_VERSION = "plan-intelligence.v1"` is nested **inside** `intelligence`, following the `RECONCILE_SCHEMA_VERSION` idiom (in-band `as const` + single-value `schemaEnum` mirror). **No `schemaVersion` is added to `DeploymentPlan`**: it has none today, `validatePlan` performs no version check and `loadPlan` no migration, so a required top-level version would either be silently ignored or strand every already-saved plan. Absence of `intelligence` is a legal legacy state; a future `.v2` widens one enum.

### Compatibility

- **Old plans → new binary**: `intelligence` absent; renderer and `apply` both tolerate `undefined`.
- **New plans → old binary**: `loadPlan` is an unchecked cast that neither rejects nor drops unknown keys.
- **`apply` needs no change**: it reads only `intent`, `id`, `createdAt`, `composePath`, `profiles`, `summary.{toCreate,toUpdate,toRecreate}`, and `services[].{service,changeType,image.*}`. `assertOrdinaryPlanIntent` still accepts `intent === undefined`.
- **Managed-update path untouched**: `ManagedUpdatePlan` is built as a fresh object literal that lifts only `basePlan.id` and `basePlan.createdAt`; `assertExactKeys` never sees a `DeploymentPlan`, so `MANAGED_UPDATE_PLAN_SCHEMA_VERSION` does not move.
- **State DB untouched**: nothing is added to `ServiceChange`, so `config_snapshot` and `generations` rows are byte-identical.

### Payload size and secret surface

`intelligence.services` holds an entry only for services with at least one reason — typically 1-6 entries of ~400-900 bytes. A no-op plan adds ~250 bytes (provenance + empty record + summary). Caps: 8 reasons × 6 evidence strings, 10 dependents, 6 changing dependencies.

Secret surface is **net neutral**. Everything emitted is already derivable from the same plan file: environment variable _names_ (already `EnvChange.name`), image references (already `ImageDiff`), 12/19-char hash and digest prefixes (one-way SHA-256; `resolvedConfigFingerprint` is asserted secret-free by `plan-generator.spec.ts:98-119`), service names, and ISO timestamps. No `EnvChange.current`/`.desired` value is ever copied, and no raw registry or subprocess text is admitted — only `canonicalImage` and digests, which already pass the ten-code `classifyRegistryFailure` redaction gate.

---

## Module layout & file boundaries

```
src/types/plan-intelligence.ts        ~165  contracts, CHANGE_REASON_CODES, caps, schema version
src/types/plan.ts                       +6  DeploymentPlan.intelligence?, PlanOptions.intelligence?
src/lib/plan-intelligence.ts          ~330  PURE: classify + impact + summary. No I/O, no logging
                                            beyond logDebug, no process.exitCode.
src/lib/plan-baseline.ts              ~110  ONLY I/O: listPlans/loadPlan/hashFile, scope-gated,
                                            never throws.
src/lib/formatters/plan-intelligence.ts ~120  PURE: string[] renderers (concise + verbose).
src/lib/dependency-graph.ts            +18  invertDependencyMap (shared with staged-rollout).
src/lib/plan-generator.ts              +40  determineChangeType returns {changeType, decisive};
                                            one gated buildPlanIntelligence call site.
src/actions/plan.ts                    +45  --explain plumbing, baseline load, line emission,
                                            planResultForOutput.
```

Rules honoured: `src/types/*` imports nothing from `src/lib/*`; every relative import ends in `.js`; no `any` (use `unknown` + narrowing at the baseline parse boundary); discriminated unions on literal `status`/`baseline` discriminants with `/** Discriminant */` markers; `as const` objects instead of enums; every new file under the ~500-line soft cap; `actions/plan.ts` stays at ~450 lines because rendering lives in a formatter module. `dependency-graph.ts` (543 lines) is already over the soft cap; adding 18 lines there is still correct — it is the graph domain, and a new file for one function or a duplicate inverter are both worse. Splitting `dependency-graph.ts` is a separate refactor.

---

## Files to change (exhaustive checklist)

### New source (4)

1. `packages/rfapps-cli/src/types/plan-intelligence.ts`
2. `packages/rfapps-cli/src/lib/plan-intelligence.ts`
3. `packages/rfapps-cli/src/lib/plan-baseline.ts`
4. `packages/rfapps-cli/src/lib/formatters/plan-intelligence.ts`

### Modified source (12)

5. `packages/rfapps-cli/src/types/plan.ts` — `DeploymentPlan.intelligence?`, `PlanOptions.intelligence?`
6. `packages/rfapps-cli/src/types/index.ts` — re-export the new types + `PLAN_INTELLIGENCE_SCHEMA_VERSION` + `CHANGE_REASON_CODES`
7. `packages/rfapps-cli/src/lib/dependency-graph.ts` — export `invertDependencyMap`
8. `packages/rfapps-cli/src/lib/staged-rollout.ts` — `computeFanIn` derives from `invertDependencyMap`
9. `packages/rfapps-cli/src/lib/plan-generator.ts` — `determineChangeType` returns `{ changeType, decisive }`; gated `buildPlanIntelligence` call
10. `packages/rfapps-cli/src/lib/index.ts` — barrel: `buildPlanIntelligence`, `loadPlanBaseline`, `invertDependencyMap`
11. `packages/rfapps-cli/src/lib/formatters/index.ts` — re-export the two new formatters
12. `packages/rfapps-cli/src/actions/plan.ts` — `--explain` plumbing, baseline load, `why:`/`impact:`/registry-drift/summary lines, `planResultForOutput`
13. `packages/rfapps-cli/src/cli.ts` — `.option("--explain", …, false)` after `--check-updates` (line ~530)
14. `packages/rfapps-cli/src/actions/completion.ts` — **three independent template edits** (below)
15. `packages/rfapps-cli/src/mcp/schema.ts` — `PlanToolArgs.explain`, `planInputSchema.explain`, three new schemas, `deploymentPlanSchema.intelligence`, `_typeCheck.planIntelligence`
16. `packages/rfapps-cli/src/mcp/adapters.ts` — `invokePlan` passes `explain`

### Shell completion — all three templates (in file 14)

- **bash**, line 71: append space-prefixed `--explain` to `local plan_opts="…"`. No `case "$prev"` arm needed — boolean, takes no value. The `plan)` dispatch arm at 297-299 already splices `$plan_opts $global_opts`.
- **zsh**, the `plan)` `_arguments` arm at 634-648: insert `'--explain[Annotate changes with likely cause and dependency impact]' \\` **immediately after** the `--check-updates` line. Inserting mid-arm avoids the trailing-backslash surgery required to append after line 647 (`--profile`), which is the only line with no continuation.
- **fish**, block at 1119-1130: add `complete -c rfapps -n "__fish_seen_subcommand_from plan" -l explain -d "Annotate changes with likely cause and dependency impact"`. No `and not` guard — no other subcommand is named `plan`.

### Tests (5 files)

17. `packages/rfapps-cli/src/lib/plan-intelligence.spec.ts` — **new** (T1-T4)
18. `packages/rfapps-cli/src/lib/plan-baseline.spec.ts` — **new** (T5)
19. `packages/rfapps-cli/src/lib/formatters/plan-intelligence.spec.ts` — **new** (T8)
20. `packages/rfapps-cli/src/mcp/schema.spec.ts` — modified (T6)
21. `packages/rfapps-cli/src/actions/completion.spec.ts` — modified (T7: add `"explain"` to the hard-coded `required` array at ~415-428)
22. `packages/rfapps-cli/src/actions/plan.spec.ts` — modified: one new `--explain` case that mocks `loadPlanBaseline`. Existing cases are untouched because they never set `explain`, so the exact-literal `generatePlan` assertion at 167-175 stays byte-identical.
23. `packages/rfapps-cli/src/lib/plan-generator.spec.ts` — modified: ~4 assertion lines on the existing full-plan test proving the `determineChangeType` refactor did not change any `changeType`, and that no `intelligence` key appears without `options.intelligence`.

### Docs (7)

24. `packages/rfapps-cli/README.md` — plan options table (~1089-1101) gains an `--explain` row; workflows block (~2127-2150) gains an example
25. `docs/features/plan-apply-workflow.md` — canonical plan options table (~103-115) gains `--explain`; new "Change origin and impact" section
26. `docs/features/rfapps-plan-intelligence.md` — **new** feature page: reason-code table, `confirmed`/`inferred` semantics, the full degradation ladder, and documented limitations (multi-file compose, secrets-tool/Compose-CLI false positives, profile scoping, `--out` plans invisible to `listPlans`, `depends_on` conditions flattened, sidecar mapping not applied)
27. `docs/features/shell-completion.md` — add the currently-missing `rfapps plan --<TAB>` block (~145-198)
28. `docs/features/quick-reference.md` — plan block (~203-223) gains `rfapps plan --explain`
29. `AGENTS.md` — flag list gains `--explain` as "plan command only" beside `--check-updates`
30. `ROADMAP.md` — mark issue #152 (Sprint 1, order 2) delivered
31. `docs/plans/152-contextual-plan-intelligence/design.md` — this document, committed as `docs(internal): …`

### Not changed (verified)

`src/actions/apply.ts`, `src/lib/plan-storage.ts`, `src/lib/managed-update.ts`, `src/lib/schema.sql`, `src/lib/migrations.ts`, `src/types/state.ts`, `CLAUDE.md` (its quick-reference names commands, not every flag).

---

## Test plan (lean, each test justified)

Eight tests, matching the eight-test staged-deploy precedent for a comparable feature. `it.each` tables over enumerated near-duplicate blocks. All specs `import { describe, it, expect, vi } from "vitest"` explicitly despite `globals: true`, use `vi.clearAllMocks()` in `beforeEach`, module-level factory helpers for `ServiceChange` fixtures, and narrow unions with helpers that **throw** on a wrong variant rather than silently skipping assertions.

**T1 — `plan-intelligence.spec.ts`: trigger cascade matrix.** `it.each` over: `create` → exactly one `container-not-running` (create-suppression); `recreate` → `image-reference-changed` `decisive: true` **plus** the concurrent env/volume reasons at `decisive: false`; `update` → every changed dimension `decisive: true`; `unchanged` + `updateStatus: "update-available"` → exactly one `registry-image-drifted`; `unchanged` + each of `unsupported`/`unknown`/`local-missing` → no entry at all; `unchanged` + nothing → absent from `services`.
_Required because:_ this is the entire "why" contract, and its failure mode is a **confidently wrong** sentence with no crash. The `unsupported`/`unknown` rows pin the five-valued-status discrimination that `ImageUpdateStatus` was introduced to force — claiming "upstream drifted" on a build-only service destroys the operator trust the feature exists to build.

**T2 — `plan-intelligence.spec.ts`: provenance matrix and degradation.** `it.each` over: baseline `unavailable` → no provenance reason and `provenance.baseline === "none"`; fingerprint moved + `composeFileChanged: true` → `compose-file-edited` / `inferred`; fingerprint moved + `composeFileChanged: false` → `resolved-config-changed` / `inferred`; fingerprint equal → `unchanged-since-baseline` / `confirmed`; baseline lacks the service → no provenance reason; **`runtimeStateObserved: false` → zero `container-not-running` reasons across all services**.
_Required because:_ this is the "never confidently wrong" contract. A flipped boolean tells the operator "someone edited compose.yml" when a secret rotated. And a `docker compose ps` failure makes every service report `create` today — asserting a cause for state we never observed turns a visually implausible wall of `+ create` into 47 verified-sounding false statements. Also pins that provenance is never `confirmed`.

**T3 — `plan-intelligence.spec.ts`: bounds, secret-freedom, and non-negative counters.** With 30 changed env vars and 40 dependents: `evidence.length === MAX_REASON_EVIDENCE` and `dependents.length === MAX_IMPACT_DEPENDENTS` with truncation flags set while `dependentCount` reports the true total; `JSON.stringify(intelligence)` contains no `EnvChange.current`/`.desired` value including a canary plaintext on a var flagged `isSecret: true`; and a plan whose only changing services are leaves yields `downstreamImpacted === 0`.
_Required because:_ three distinct silent failures in one fixture. A value leak writes real secrets into `.rfapps/plans` and onto MCP stdout. An unbounded payload grows every saved plan. And a naive `|reached| - |changing|` computation goes **negative** for the modal case (leaf services), which fails `schemaNumber({ minimum: 0 })` and breaks every `rfapps.plan` MCP call with an unnameable union error.

**T4 — `plan-intelligence.spec.ts`: impact graph.** One fixture with a cycle, a diamond, and a dependent outside the plan's target list. Assert: traversal terminates; seed excluded; transitive dependents counted; the out-of-scope dependent **is** counted; `runningDependentCount` counts only members of `runningServices`; `changingDependencies` lists only direct dependencies with `effect === "replace"`; `effect` maps `unchanged→none`, `create→create`, `update`/`recreate`→`replace`.
_Required because:_ an unguarded upward BFS **hangs the CLI** on a `depends_on` cycle (a first-class tested condition elsewhere), and building the index over the target scope silently under-reports dependents — precisely the failure impact reporting exists to prevent. Both are invisible in normal output.

**T5 — `plan-baseline.spec.ts`: scope gating and degradation.** `it.each` over: newest plan targets a different `composePath` → skipped in favour of an older matching one; a candidate with different `profiles` → skipped; `intent: "managed-update"` → skipped; `composeHash: ""` → skipped; no candidate matches → `{ status: "unavailable", reason: "no-comparable-plan" }`; plan directory absent or unreadable → `{ status: "unavailable", reason: "plan-history-unreadable" }`, never a throw.
_Required because:_ `listPlans()` is mtime-ordered with no filtering and `savePlan` runs on **every** `rfapps plan`, so an unfiltered baseline compares one compose file's bytes against another file's hash and labels every service `compose-file-edited` — a confidently-wrong-attribution generator. The never-throws property is what keeps `rfapps plan` from failing because of an unrelated stale artifact.

**T6 — `mcp/schema.spec.ts`: real round-trip.** Feed an actual `buildPlanIntelligence(...)` output — not a hand-written literal — into `rfappsMcpSchemas.plan.output.parse` and assert it parses and retains `plan.intelligence`; alongside the existing unknown-key rejection case.
_Required because:_ `schemaObject` is `additionalProperties: false` and the plan result is wrapped in `withDryRun(...) = schemaUnion`, so a missed or divergent schema fails at **runtime** with `No union variant matched at $`, naming neither tool nor key. `npm run typecheck` cannot catch it: `McpSchema<T>` is covariant, so a schema omitting an optional field still satisfies the `_typeCheck` anchor. Using a real builder output (not a literal) is what catches an omitted field, a wrong enum, or a required-key mismatch.

**T7 — `actions/completion.spec.ts`: add `"explain"` to the `required` token array.** One line.
_Required because:_ there is **no** Commander↔completion parity test for `plan` (`getCommanderCommandOptions` is typed `"deploy" | "rebuild"`), so a missed bash/zsh/fish template edit ships a silently incomplete shell with green CI. This one-line addition is the only guard, and it is the same mechanism already protecting `check-updates`, `staged`, and `batch-size`.

**T8 — `formatters/plan-intelligence.spec.ts`: the two safety-critical rendering rules.** (a) `impact:` is omitted entirely when `dependentCount === 0`; (b) the concise `why:` line carries the space-prefixed `[inferred]` suffix when the lead reason is inferred and omits it when `confirmed`.
_Required because:_ 37 of 48 services in this deployment have zero dependents, so rule (a) governs the majority of output — and printing a reassuring `0 dependents` where the real coupling is shared `${DATA_DIR}` mounts and Traefik routing would actively mislead an operator into bouncing a service. Rule (b) is the visual half of the never-confidently-wrong contract. `diff-helpers.spec.ts` is the in-repo precedent for output-string testing with identity-mocked colors, so this is conventional, not novel.

### Deliberately not written

- **Renderer tests beyond T8's two rules.** ANSI/copy churn with no safety value; `diff-helpers.spec.ts` pins semantics, not prose.
- **A Commander↔completion parity case for `plan`.** T7's token assertion gives the same coverage for one line instead of widening a typed helper union.
- **Tests that `generatePlan` attaches `intelligence`.** Covered by T6 (real builder output) and by the T1 fixtures; the wiring is a gated three-line call.
- **`apply` compatibility tests.** `apply` reads a fixed narrow slice; asserting it ignores an unknown key tests JavaScript.
- **An integration spec (`src/cli.plan.integration.spec.ts`).** `--explain` issues **zero** additional Docker invocations, so the canned-Docker harness has nothing to observe; it would only re-cover T1 at above the 12 s harness budget.
- **Threshold/constant tests.** The four caps are documented tuning constants; asserting them restates the source.

### Verification gate

```bash
umask 022 && env -u FORCE_COLOR npm run build -w packages/rf-common \
  && env -u FORCE_COLOR npm run typecheck -w packages/rfapps-cli \
  && env -u FORCE_COLOR npm run test:run -w packages/rfapps-cli \
  && npm run format:all \
  && npm run lint:md
```

`format:all`, not `format`. `env -u FORCE_COLOR` and `umask 022` are known environment traps that otherwise fail unrelated rf-common logger and filesystem tests.

---

## Risks & explicit non-goals

### Risks

- **`resolved-config-changed` has multiple possible causes and is labelled accordingly.** A different secrets tool between runs (`--use-dotenvx` vs none), a Docker Compose CLI upgrade that renormalizes `docker compose config` output, or `extends:` all move the resolved fingerprint with identical compose bytes. Mitigated by `confidence: "inferred"` plus alternatives named in the reason's own summary — never by silence and never by a `confirmed` claim.
- **`compose-file-edited` sees only the top-level compose path.** `hashFile` covers `plan.composePath`, not `include:` files, additional `-f` overrides, or the env file. Verified: this repo's `compose.yml` has zero `include:` directives and the CLI passes a single `-f`, so it is latent today. If multi-file compose support lands, the reason must be suppressed rather than downgraded.
- **The baseline is the last _planned_ state, not the last _applied_ state.** `unchanged-since-baseline` explicitly names this ("already pending since plan X"), and `provenance` always prints the baseline plan id and timestamp so the operator can see exactly what the comparison is against. `git diff compose.yml` remains a better answer to "did I edit compose"; the feature's incremental value is the _interpolation-only_ case, which git cannot see.
- **Plans written with `--out <path>` are invisible to `listPlans()`**, so an operator who habitually uses `--out` always sees `Change origin: unavailable`. Documented in the feature page.
- **`impact` counts declared `depends_on` edges, not runtime coupling.** Compose does not restart dependents, and `apply` deploys only the plan's own change set. In this deployment only 11 of 48 services have any dependent, and the real coupling runs through shared `${DATA_DIR}` bind mounts, Traefik routing, and the single `apps` network — all invisible here. Mitigated by the wording rule ("N services declare depends_on X") and by omitting the line entirely at zero.
- **`depends_on` conditions are flattened.** `getComposeServiceDependencies` drops the condition value, so `service_healthy` (a hard readiness gate) and `service_started` (a soft ordering hint) are weighted identically.
- **`{}` sidecar mapping.** With `sidecars.enabled: true` (supported by the CLI, off in this deployment), plan impact would omit sidecar-propagated edges that `deploy` honours.
- **Profile scoping.** `composeServices` is the resolved model for the _active profiles_. Inert today (`compose.yml` declares zero service-level `profiles:`), but adopting profiles would narrow both the dependent graph and the fingerprint comparison.
- **Stopped containers.** `docker compose ps --status running` cannot distinguish `exited`/`paused`/`restarting` from nonexistent, so a crash-looping container yields `changeType: "create"`. Mitigated only by wording ("no running container found (a stopped container is not inspected)"). Reading `ContainerInspect.State` would change `determineChangeType` and belongs in a separate issue.
- **Extra I/O per `--explain` run.** One `readdir`, up to 10 `readFile` calls, and one `hashFile`. Sub-millisecond in practice, and paid only under `--explain`; `managed-update` and `doctor` pay nothing.
- **`--explain` amplifies existing false positives.** Compose/Docker path-normalization and ordering artifacts already produce occasional spurious volume and port diffs; today they yield a quiet `update`, and after this change they yield a printed sentence. This feature inherits the accuracy of the five underlying diffs.

### Explicit non-goals

1. **No SQLite state database access.** Deferred to a follow-up issue that must first fix the read/write path divergence (eight actions call bare `initializeDatabase()` and ignore `config.state.dbPath`) and the snapshot-fidelity gap (`deploy`/`rebuild` write only `{"image":"…"}`; `apply` writes an _unmasked_ `ServiceChange`).
2. **No new `deployments`/`generations` columns, no schema v4 migration.**
3. **No changes to `ServiceChange`, `PlanSummary`, or the persisted state rows.**
4. **No fix for `rfapps plan --output csv`**, which already throws (`flattenObject` `MAX_DEPTH = 2`). Pre-existing and out of scope; `planResultForOutput` only guarantees no regression.
5. **No change to `determineChangeType`'s verdicts.** It gains a second return field; every existing `changeType` outcome is byte-identical (pinned by T23's assertions on the existing plan-generator spec).
6. **No shared-mount or shared-network impact analysis.**
7. **No `rfapps why` / `rfapps explain` subcommand.**

---

## Rejected alternatives (with reasons)

- **Annotations as new fields on `ServiceChange`** (what the issue's file list implies). `apply.ts:742`/`:759` writes `JSON.stringify(serviceChange)` into `config_snapshot` for every applied _and_ failed service, and `recordGeneration` mirrors it into the append-only `generations` table. Every annotation would permanently grow state rows and nest an attribution payload inside the snapshot used to compute future attribution. Plan-level placement also shrinks the MCP diff to one optional key on `deploymentPlanSchema` instead of editing the anchored `serviceChangeSchema`.

- **State-DB attribution as the primary baseline.** `deploy`/`rebuild` — the commands operators actually run — write `config_snapshot = {"image":"<tag>"}` with NULL `image_id`/`image_digest`; only `apply` rows carry a `resolvedConfigFingerprint`; `import`/`state rebuild` rows record observed container reality that may never have matched compose, making "observed unchanged ⇒ compose moved" invalid; managed `update` writes a pre-flight generation with the _old_ image and no snapshot, which `MAX(generation)` promotes over a usable `apply` row; and `getStateDbPath(config)` can point at a different file than the writers used. Rich for apply-deployed services and empty for deploy-deployed ones — inconsistent per service, which is worse than uniformly absent.

- **No flag at all, gating on the existing `-v/--verbose`.** Rejected despite the accurate nine-edit-site cost accounting: it changes the default `--output json` payload for every existing machine consumer, adds filesystem I/O to every `rfapps plan`, and would compute annotations for `managed-update`/`doctor`, which never read them. `--check-updates` is the established precedent that new evidence-gathering passes are opt-in.

- **Numeric `confidence: number` in [0,1].** Fake precision with no calibration source and no consumer that could act on 0.7 vs 0.8. `confirmed | inferred` maps to a checkable distinction.

- **A per-code discriminated payload union for `ChangeReason` (ten variants).** `schemaUnion` reports failures only as `No union variant matched at $`, and the plan result is _already_ inside one union via `withDryRun`. A nested ten-variant union makes any future schema slip undebuggable. A flat record with a literal-union `code` plus `evidence: string[]` is weaker typing for a payload consumers only display, and collapses the MCP schema to one object.

- **`ServiceImpact.restarts: boolean`.** False for `create` (nothing exists to restart) yet the only reasonable reading of the name is "an existing workload is interrupted". Renaming later would be the breaking change this design exists to avoid. `effect: "none" | "create" | "replace"` is correct now and forward-compatible with `delete`, which today is unreachable but would otherwise score as harmless.

- **`impactedDependents = |union| − |changing|`.** Goes negative whenever the changing services are leaves — the modal case here — and fails the MCP `minimum: 0` constraint. Replaced with an explicit set difference.

- **Reusing `staged-rollout`'s `compareBlastRadius` ranking, or exporting `computeFanIn` as-is.** `compareBlastRadius` remains the sole authority for rollout _ordering_; plan intelligence reports reach and deliberately does not re-rank. `computeFanIn` yields counts only, with no names and no transitive closure — so `invertDependencyMap` is extracted into `dependency-graph.ts` and _both_ consume it, rather than shipping two inverters or coupling the rollout batcher to plan rendering.

- **A separate `plan-reasons.ts` + `plan-impact.ts` split.** Both are ~150 lines of pure derivation over the same inputs and would need a shared context type; one ~330-line `plan-intelligence.ts` is under the cap and has one reason to exist ("derive annotations"). The split that _is_ justified — pure logic vs I/O — is honoured via `plan-baseline.ts`.

- **`com.docker.compose.config-hash` container label** (free in the already-fetched `ContainerInspect.Config.Labels`). rfapps cannot recompute Compose's internal hash, so within a single plan run there is nothing to compare it against; it is only useful paired with a stored baseline, and a Compose version upgrade would flip it for every container simultaneously — a mass false positive.

- **Shared-network impact.** All 44 network-declaring services join the single `apps` network; grouping by it marks every service as impacting every other.

- **Shared bind-mount impact.** Needs subpath containment over interpolated absolute paths and an O(n²) pass with the `EvaluationBudget` machinery, for a signal that would surface `${DATA_DIR}` as a permanent 5-way coupling on every plan.

- **A required `schemaVersion` on `DeploymentPlan`.** `loadPlan` performs no validation or migration, so it would either be silently ignored or strand every saved plan. Versioning lives on the nested optional object where absence is a legal legacy state.

- **Reading `ContainerInspect.State.Health` to flag unhealthy services.** `getRunningServiceContainerMap` filters with `--status running`, so every inspected container is Running by construction; health reporting is `rfapps health`'s job, and a second less-maintained health surface in front of operators is scope creep.

- **An `errors`/`suggestions` surface or a new exit code.** `--explain` is purely additive annotation; it never fails a plan, so no new `ExitCode`, error class, or formatter is introduced.
