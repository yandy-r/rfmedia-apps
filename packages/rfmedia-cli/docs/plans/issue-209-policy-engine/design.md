# Design — Consumption-Driven Lidarr Policy Engine (`rfmedia lidarr policy evaluate`)

> Issue #209 · rfmedia-cli · ROADMAP Sprint 1 Layer 3 (downstream of #207 identity bridge and #208/#284/#285 reconciliation)

---

## 1. Goal

Add `rfmedia lidarr policy evaluate`: a **strictly read-only** engine that joins Plex consumption signals onto the shipped Plex↔Lidarr identity bridge and reports **explainable proposed Lidarr actions**, each carrying the exact threshold arithmetic that produced it and an inert argv handoff to an already-shipped plan producer.

Three initial policies ship:

| Rule id                    | Intent                                                        | Proposed action                 |
| -------------------------- | ------------------------------------------------------------- | ------------------------------- |
| `rating-quality-upgrade`   | Highly-rated artists deserve a better quality profile         | `artist-profile-assignment`     |
| `stale-monitoring-cleanup` | Monitored artists with no demonstrated consumption            | `artist-monitoring` (unmonitor) |
| `discovery-seed`           | High-signal artists absent from Lidarr become discovery seeds | none (inert seed)               |

The engine is a **registry clone of the shipped `rfmedia lidarr audit` engine** (`src/lib/lidarr/audit.ts`), with `LidarrAuditFinding` replaced by `PolicyProposal`. Extensibility is a frozen descriptor table plus a total `Record` map — roughly 60 lines — not a DSL, plugin loader, or class hierarchy.

### Success criteria

1. A run with no `policy:` config prints all three rules with titles, descriptions, and skip reasons — self-teaching first run.
2. Every proposal names the exact `.rfmedia.yaml` key that produced it (`PolicyThresholdCheck.configPath`).
3. Every _refusal_ is individually visible as a `PolicySkip`, never an omission.
4. A review-grade (name-evidence) identity **cannot** reach a proposal — enforced by the type system, not by review discipline.
5. `evaluate` writes zero bytes to Plex, Lidarr, the plan directory, and the tracking DB (beyond the pre-existing observational snapshot replace inside the reused `executeLidarrReconcile`).

---

## 2. Non-goals — explicit scope boundary

### 2.1 No mutation, and no plan artifact

`policy evaluate` performs **zero writes**. Unlike every `src/actions/lidarr/plan-*.ts` producer, it does not call `writeLidarrPlanArtifact`. It calls no member of `LidarrClientApi` governed by the five `lidarr-*-mutation-owner` rules in `scripts/check-direct-plex-imports.mjs` (`setArtistProfiles`, `updateArtistTags`, `deleteAlbum`, `setAlbumAnyReleaseOk`, `bulkDeleteTrackFiles`, `addArtist`, `setAlbumsMonitored`), so **no module needs adding to any owners `Set`**. It never calls `MediaServerMetadataCapability.updateTrackRating`.

A `policy plan` verb is **deliberately deferred to a child issue**. The `policy` parent command exists so the verb can be added later without a rename, and every `PolicyProposal` already carries `handoff.producer` naming its target producer — the follow-up is a mechanical mapping. This honours `docs/features/plex-lidarr-reconciliation.md:209-219` ("cached reconciliation evidence never authorizes a mutation") and the ROADMAP's "separately authorized policy work".

### 2.2 No plan-contract change

No `rfmedia.lidarr-plan.v4`, no new top-level or per-entry plan key, no new `operation.kind`, no entry in `plan-operation-definitions.ts` / `plan-album-operations.ts`, no edit to `plan-engine.ts` (4 800 lines) or `types/lidarr-plan.ts` (1 332 lines). `requireExactKeys` (`src/lib/lidarr/plan-validation.ts:24`) freezes the v3 envelope at 13/15 keys and the validator re-derives `cascadeAnalysis` from canonical plan facts, so a `policy`/`ruleId`/`rationale` field on an artifact is structurally impossible. **Policy provenance lives in the evaluation report, never in a plan artifact.**

### 2.3 Boundary vs #221 (Plex ratings sync) — the sharpest line

\#209 **reads** `MediaEntityBase.rating`. It never **writes** it. `MediaServerMetadataCapability` is not imported by any file in this design. No rating propagation, no bidirectional reconciliation, no rating-sync config, no conflict resolution.

What #209 leaves open for #221 at zero cost: `POLICY_SIGNALS`, `POLICY_RULE_IDS`, `POLICY_RULE_DESCRIPTORS` and `EVALUATORS` are parallel closed unions plus total `Record` maps. #221 becomes **one entry in each** — no engine change, no report-shape change, no config restructuring, no `PolicyEvaluationReport` v2.

### 2.4 Boundary vs #204 (federated discovery) and #210 (timeline)

`discovery-seed` performs **no Last.fm call**, constructs no `LastFmClient`, adds no `FETCH_OWNERS` entry, and emits no `artist-add` plan. `LidarrArtistAddProvenanceV2` (`src/types/lidarr-plan.ts:475`) is literal-typed `source: "lastfm"` / `method: "artist.getSimilar"` and structurally cannot carry policy provenance. Seeds terminate at an inert `lidarr discover --artist "<name>"` handoff; the existing `discover` leaf keeps sole ownership of that provider boundary and its traversal budgets.

\#210 (timeline) is untouched: no `lastViewedAt`, `skipCount`, `lastRatedAt`, `viewOffset`, or item-level `addedAt` is added to any layer. Those fields do not exist anywhere in the codebase, and adding one requires a coordinated change across `PlexWireTrack` + its `isPlexWireTrack` guard + `mapPlexTrack` + `MediaTrack` (+ `MediaFilterField`, `getMediaFieldValue`, the Plex pushdown translators, and `PLEX_FEATURES.filterPushdown.fields` if filterable). **Consequence: "stale" in this engine means low absolute play count, never recency.** This is stated plainly in the feature doc and in the rule's `description` string.

### 2.5 Other exclusions

- **No `--offline`.** Consumption requires a live Plex read; `bridge_identity_snapshots` carries zero consumption evidence, so an offline run could only emit skips. `resolveOfflineReconcileOrigins` (`src/lib/config.ts:4094`) and `isCredentialFreeOfflineReconcile` (`src/cli.ts:115`) are untouched.
- **No `--dry-run` flag.** Evaluation is always dry; offering the flag would imply a non-dry mode exists.
- **No config-primitives extraction.** The policy validator goes inline in `src/lib/config.ts` following the `discovery.lastfm` precedent (`config.ts:2573-2645`). Extracting `ConfigError`/`describeType`/`rejectUnknownConfigKeys`/the primitive validators touches a 4 794-line module with a 3 331-line co-located test — a worthwhile refactor and a bad thing to smuggle into a feature PR. **Child issue.**
- **No override/dispute subsystem.** No `policy.overrides`, no content-addressed decision ids, no `verdict: suppress`. `--explain` uses a **stable, non-rotating** decision key. **Child issue.**
- **No album- or track-level rules.** `BridgeIdentityKind` is the literal `"artist"` at both the type level and the SQL `CHECK (entity_kind = 'artist')`. Album scope needs a new entity kind, a migration, and a snapshot version bump.
- No schema/DB change (`schema_version` stays 11), no snapshot version bump, no persistence of proposals, no MCP surface, no scheduled evaluation, no benchmark.

---

## 3. Architecture overview

```
src/commands/lidarr-policy.ts          leaf factory (policy → evaluate)
  └─ src/commands/lidarr-policy-presenter.ts   rendering, CSV schema, --explain
       │  (deps injected from src/commands/lidarr.ts; imports nothing from it)
       ▼  lazy: await import("../actions/lidarr/index.js")
src/actions/lidarr/policy-evaluate.ts  IMPURE EDGE. TIER = "local-only". DI seam.
  ├─ src/actions/lidarr/policy-gather.ts       never-throw slot gatherers
  │    ├─ resolveRequiredMediaServerAdapter    src/lib/adapters/action-helpers.ts:37
  │    ├─ advancePaginationOffset              src/lib/pagination.ts:14
  │    └─ resolveRequiredLidarrClient          src/lib/lidarr/index.ts:294
  └─ executeLidarrReconcile                    src/actions/lidarr/reconcile.ts:466
       ▼
src/lib/bridge/policy-signals.ts       PURE join layer  ← highest defect risk
src/lib/bridge/policy-engine.ts        PURE orchestrator (clone of lib/lidarr/audit.ts)
src/lib/bridge/policy-rules.ts         PURE evaluators (3 rules)
src/lib/bridge/policy-rule-support.ts  PURE shared primitives + sole proposal factory
src/types/lidarr-policy.ts             THE contract — ZERO value imports
```

### 3.1 Verified reused symbols

Every symbol below was read from source in this repo at the cited line.

| Symbol                                          | Location                                             | Verified fact                                                                                                      |
| ----------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `PlexLidarrReconciliationResultV1.matchedExact` | `src/types/bridge.ts:586`                            | The authoritative array. **There is no `.authoritative` field.**                                                   |
| `ReconciliationAuthoritativeItem`               | `src/types/bridge.ts:385`                            | `source: ReconciliationSourceIdentity` (non-null), `target: ReconciliationTargetIdentity & { artistMbid: string }` |
| `ReconciliationSourceIdentity`                  | `src/types/bridge.ts:338`                            | `{ plexId: string; title: string; artistMbid: string \| null }`                                                    |
| `ReconciliationSourceUnmatchedItem`             | `src/types/bridge.ts:427`                            | `category: "unmatched"`, `reason: "insufficient-score" \| "no-candidate" \| "missing-source-mbid"`                 |
| `ReconciliationPlexOnlyItem`                    | `src/types/bridge.ts:497`                            | A **union incl. review/ambiguous/conflict** — must NOT be seeded from wholesale                                    |
| `MediaServerQueryCapability.artists`            | `src/types/media-server.ts:330`                      | `(options: MediaQueryOptions & { readonly kind: "artist" })` — **`kind` IS part of the call signature**            |
| `MediaArtist.id` ← `wire.ratingKey`             | `src/lib/adapters/plex/mappers.ts:172`               | Same id namespace as …                                                                                             |
| `MediaArtistIdentity.id` ← `wire.ratingKey`     | `src/lib/adapters/plex/identity.ts:102`              | … the bridge's `source.plexId`. **Exact-id join is sound.**                                                        |
| `mapPlexTrack` artist fallback                  | `src/lib/adapters/plex/mappers.ts:141`               | `track.grandparentTitle ?? "Unknown Artist"` — sentinel bucket hazard                                              |
| `MediaTrack`                                    | `src/types/media-server.ts:59-66`                    | `artist: string` (no id), `playCount: number`                                                                      |
| `LidarrArtist.statistics`                       | `src/types/lidarr.ts:181`                            | **OPTIONAL** — "Lidarr may omit it for freshly-added or unscanned artists"                                         |
| `LidarrProfile`                                 | `src/types/lidarr.ts:297`                            | `{ id: number; name: string }`                                                                                     |
| `evaluateMediaFilterRule`                       | `src/lib/media-filter-evaluator.ts:141`              | Returns `rule.operator === "!=" \|\| "not_contains"` when the field is `undefined`                                 |
| `getMediaFieldValue`                            | `src/lib/media-filter-evaluator.ts:73`               | `artistRating` → `undefined` when `item.rating === null`                                                           |
| `MediaFilterRule.value`                         | `src/types/media-filters.ts:37-45`                   | "Rating values use the public 1-5 star input scale"                                                                |
| `normalizeBridgeArtistName`                     | `src/lib/bridge/artist-name.ts:5`                    | Versioned by `BRIDGE_ARTIST_NORMALIZATION_VERSION`                                                                 |
| `advancePaginationOffset`                       | `src/lib/pagination.ts:14`                           | Throws on a stalled page                                                                                           |
| `resolveRequiredMediaServerAdapter`             | `src/lib/adapters/action-helpers.ts:37`              | Sole sanctioned Plex reach                                                                                         |
| `resolveRequiredLidarrClient`                   | `src/lib/lidarr/index.ts:294`                        | `listArtists(signal?)` at `client.ts:220`, `listQualityProfiles(signal?)` at `:302`                                |
| `resolveLidarrScheduler`                        | `src/lib/lidarr/index.ts:196`                        | `.runSingle(TIER, task, { signal })`                                                                               |
| `LidarrTier`                                    | `src/lib/lidarr/tiers.ts:27`                         | `"local-only" \| "metadata-dependent" \| "discovery" \| "destructive"`                                             |
| `executeLidarrReconcile`                        | `src/actions/lidarr/reconcile.ts:466`                | Returns `{ report, execution? }`                                                                                   |
| `LidarrAuditSlot<T>` shape                      | `src/types/lidarr-audit.ts:264`                      | Copied (not imported) — see §3.3                                                                                   |
| `runLidarrAudit` engine                         | `src/lib/lidarr/audit.ts:1-28, 93, 380-430, 500-540` | The cloned skeleton                                                                                                |
| `probeLidarrAuditPlex`                          | `src/actions/lidarr/audit-plex.ts:116`               | Never-throw slot probe reference                                                                                   |
| `validateStarRating`                            | `src/lib/config.ts:410`                              | 1.0–5.0                                                                                                            |
| `rejectUnknownConfigKeys`                       | `src/lib/config.ts:203`                              |                                                                                                                    |
| `validateDiscoveryConfigOptions`                | `src/lib/config.ts:2626`                             | Section-validator template                                                                                         |
| `validateConfig` registration chain             | `src/lib/config.ts:3988-4000`                        | The **single** hook point                                                                                          |
| `lidarr plan artist-monitoring`                 | `src/commands/lidarr.ts:949`                         | `--ids` **mandatory**, `--monitored`/`--unmonitored` conflicting, `--plan-file` **optional**                       |
| `lidarr plan artist-profiles`                   | `src/commands/lidarr.ts:1019`                        | `--quality-profile <reference>` + `addArtistSelectionOptions`                                                      |
| `defaultOutputPath`                             | `src/actions/lidarr/plan.ts:48`                      | Producer default when `--plan-file` omitted → `getDefaultPlanDir()` (`src/lib/plan.ts:121`)                        |
| Registration block                              | `src/commands/lidarr.ts:1449-1494`                   | `reconcile` at index 6; `validate-import` follows                                                                  |
| `LIDARR_COMMAND_NAMES`                          | `src/commands/lidarr.test.ts:25`                     | Ordered array asserted with `toEqual` at `:1052`                                                                   |

### 3.2 Architecture-gate compliance

`npm run check:architecture` runs under **both** `pretypecheck` and `prebuild`. Every new module must satisfy:

- **No `fetch(` / `trustedFetch(`** anywhere (raw-text match). All I/O goes through `resolveRequiredMediaServerAdapter` and `resolveRequiredLidarrClient`. No `FETCH_OWNERS` entry is added.
- **No specifier naming `./plex/*`, `src/lib/plex*`, or `src/types/plex*`** — including `import type`, since the matcher is raw text.
- **No string literal containing `/api/v1/`.**
- **`lidarr-editor-body-owner` is a purely structural object-literal key check.** Every subject/evidence/proposal literal keeps id keys **singular** — `artistId`, never `artistIds` — mirroring the `LidarrAuditSubject` comment at `src/types/lidarr-audit.ts:380`. The rule only fires when `artistIds` co-occurs with a mutation key in the _same_ literal, but singular keys make it unreachable by construction.
- No `musicbrainz` dependency or import.

Run `node packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs` continuously during implementation, not once at PR time.

### 3.3 Why `PolicySignalSlot<T>` is copied, not imported

Importing `LidarrAuditSlot<T>` would couple the policy domain to `LidarrAuditUnavailableReason`, forcing policy-specific reasons into the audit contract. An 8-line generic is duplicated to keep two independently-versioned public contracts decoupled. This is the cheaper error.

---

## 4. Type surface — `src/types/lidarr-policy.ts`

**ZERO value imports** (verbatim `src/types/lidarr-audit.ts` discipline), so `src/commands/lidarr-policy.ts` can statically import the rule-id list, CSV columns, and exit gate without loading a single evaluator or reaching the tracking DB.

```ts
/**
 * The `rfmedia lidarr policy` contract (issue #209).
 *
 * This module MUST NOT import any value from `../lib/**`. The command layer
 * statically imports it for the `--rule` value list and the exit gate; a value
 * import here would drag the evaluator graph into every cold start.
 */

import type { ReconciliationCategory, ReconciliationReason } from "./bridge.js";

/* ── Versions ────────────────────────────────────────────────────────────── */

export const POLICY_EVALUATION_SCHEMA = "rfmedia.lidarr-consumption-policy.v1" as const;
export const POLICY_ENGINE_VERSION = 1 as const;

/* ── Signal vocabulary ───────────────────────────────────────────────────── */

/** Every gatherable signal. `requires` entries are drawn from this set. */
export const POLICY_SIGNALS = [
  "bridgeIdentity",
  "lidarrArtists",
  "lidarrQualityProfiles",
  "plexArtistRatings",
  "plexTrackPlays",
] as const;
export type PolicySignal = (typeof POLICY_SIGNALS)[number];

/**
 * Why a gathered slot is absent.
 *
 * `lidarr-unreachable` is RESERVED and never minted by the shipped gatherers:
 * §8.7 makes `data-unavailable` the reason that marks a report `degraded`, and
 * a Lidarr outage must degrade rather than read as an expected absence.
 */
export type PolicySignalUnavailableReason =
  | "not-requested"
  | "plex-not-configured"
  | "lidarr-unreachable"
  | "data-unavailable";

/**
 * Presence AND reason in one value. There is deliberately no parallel
 * capability list: a slot cannot desynchronise from its own reason.
 */
export type PolicySignalSlot<T> =
  | { readonly status: "available"; readonly data: T }
  | {
      readonly status: "unavailable";
      readonly reason: PolicySignalUnavailableReason;
      readonly detail: string;
    };

/**
 * How a per-artist observation was joined.
 *
 * `exact-plex-id`     — MediaArtist.id === ReconciliationSourceIdentity.plexId.
 * `exact-artist-mbid` — the item is authoritative by construction.
 * `normalized-name`   — the WEAK join; MediaTrack carries no artist id.
 */
export type PolicyJoinGrade = "exact-plex-id" | "exact-artist-mbid" | "normalized-name";

/** Why a per-artist observation could not be made. */
export type PolicyObservationGap =
  | "unrated"
  | "no-plex-artist"
  | "ambiguous-name-join"
  | "sentinel-artist-name"
  | "no-track-coverage"
  | "lidarr-statistics-absent";

/** One observed-or-absent per-artist value with honest provenance. */
export type PolicyObservation<T extends number | boolean> =
  | {
      readonly status: "observed";
      readonly value: T;
      readonly join: PolicyJoinGrade;
      /** Rows behind an aggregate; omitted for scalar joins. */
      readonly sampleSize?: number;
    }
  | { readonly status: "unavailable"; readonly reason: PolicyObservationGap };

/* ── Rule registry ───────────────────────────────────────────────────────── */

export const POLICY_RULE_IDS = ["rating-quality-upgrade", "stale-monitoring-cleanup", "discovery-seed"] as const;
export type PolicyRuleId = (typeof POLICY_RULE_IDS)[number];

/** Existing producer a proposal hands off to; `null` for inert seeds. */
export const POLICY_PRODUCER_IDS = ["artist-profile-assignment", "artist-monitoring"] as const;
export type PolicyProducerId = (typeof POLICY_PRODUCER_IDS)[number];

/** Stable kebab decision codes — a public contract; CI may grep these. */
export const POLICY_DECISION_CODES = [
  "rating-below-target-profile",
  "monitored-artist-unconsumed",
  "high-signal-discovery-seed",
] as const;
export type PolicyDecisionCode = (typeof POLICY_DECISION_CODES)[number];

/** Stable kebab skip codes. Precedence order is fixed; see POLICY_SKIP_ORDER. */
export const POLICY_SKIP_CODES = [
  "identity-not-authoritative",
  "no-consumption-coverage",
  "ambiguous-name-join",
  "signal-unavailable",
  "rating-protected",
  "already-converged",
  "cohort-cap-exceeded",
] as const;
export type PolicySkipCode = (typeof POLICY_SKIP_CODES)[number];

/**
 * Fixed suppression precedence. An evaluator reports the FIRST blocking cause
 * in this order, so a skip code is deterministic across runs.
 */
export const POLICY_SKIP_ORDER: readonly PolicySkipCode[] = POLICY_SKIP_CODES;

/** Why a whole rule produced nothing. */
export type PolicyRuleSkipReason =
  | "not-selected"
  | "disabled"
  | "signal-unavailable"
  | "consumption-signal-empty"
  | "rule-error";

/** Static description of one registered rule. Carries no behavior. */
export interface PolicyRuleDescriptor {
  readonly id: PolicyRuleId;
  /** Short human title, echoed on every per-rule result row. */
  readonly title: string;
  /** One-line explanation, printed on a zero-config run. */
  readonly description: string;
  /** Hard gate: every entry must be an available slot or the rule skips. */
  readonly requires: readonly PolicySignal[];
  /** Soft: gathered when possible; adds depth, never gates. */
  readonly enriches: readonly PolicySignal[];
  /** Producer a proposal hands off to; null for inert seeds. */
  readonly producer: PolicyProducerId | null;
  /** Every code this rule may emit. */
  readonly decisionCodes: readonly PolicyDecisionCode[];
}

/** The registry. `satisfies` makes a missing descriptor a compile error. */
export const POLICY_RULE_DESCRIPTORS = Object.freeze({
  "rating-quality-upgrade": {
    id: "rating-quality-upgrade",
    title: "Rating-informed quality upgrade",
    description: "Highly rated Plex artists whose Lidarr quality profile is not the configured target",
    requires: ["bridgeIdentity", "lidarrArtists", "lidarrQualityProfiles", "plexArtistRatings"],
    enriches: ["plexTrackPlays"],
    producer: "artist-profile-assignment",
    decisionCodes: ["rating-below-target-profile"],
  },
  "stale-monitoring-cleanup": {
    id: "stale-monitoring-cleanup",
    title: "Stale monitoring cleanup",
    description: "Monitored Lidarr artists with no demonstrated Plex consumption (absolute plays, NOT recency)",
    requires: ["bridgeIdentity", "lidarrArtists", "plexTrackPlays"],
    enriches: ["plexArtistRatings"],
    producer: "artist-monitoring",
    decisionCodes: ["monitored-artist-unconsumed"],
  },
  "discovery-seed": {
    id: "discovery-seed",
    title: "Discovery seed generation",
    description: "High-signal Plex artists with no Lidarr candidate at all, offered as seeds",
    requires: ["bridgeIdentity", "plexArtistRatings"],
    enriches: ["plexTrackPlays"],
    producer: null,
    decisionCodes: ["high-signal-discovery-seed"],
  },
} satisfies Readonly<Record<PolicyRuleId, PolicyRuleDescriptor>>);

/* ── Identity ────────────────────────────────────────────────────────────── */

declare const POLICY_AUTHORITATIVE_BRAND: unique symbol;

/**
 * An authoritative Plex↔Lidarr artist link.
 *
 * SAFETY INVARIANT: constructible ONLY by `indexAuthoritativeIdentities` in
 * `src/lib/bridge/policy-signals.ts`, which admits only
 * `ReconciliationAuthoritativeItem` (unique one-to-one exact artist-MBID).
 * `createPolicyProposal` requires one, so review-grade name evidence cannot
 * reach a proposal without a deliberate type change. The nominal brand is what
 * makes that non-negotiable at compile time.
 */
export interface PolicyIdentityLink {
  readonly [POLICY_AUTHORITATIVE_BRAND]: true;
  readonly plexId: string;
  readonly lidarrId: number;
  readonly plexTitle: string;
  readonly lidarrTitle: string;
  readonly artistMbid: string;
}

/** Identity evidence echoed on every decision and skip. */
export interface PolicyIdentityBasis {
  readonly category: ReconciliationCategory;
  readonly reason: ReconciliationReason;
}

/* ── Subjects, checks, decisions ─────────────────────────────────────────── */

/**
 * Decision subject. Id keys are SINGULAR by contract: `artistId`, never
 * `artistIds` (the `lidarr-editor-body-owner` architecture rule is a purely
 * structural object-literal key check).
 */
export interface PolicySubject {
  readonly kind: "artist";
  readonly name: string;
  readonly plexId: string;
  /** Absent for a Plex-only seed subject that has no Lidarr counterpart. */
  readonly artistId?: number;
  readonly artistMbid: string | null;
}

/**
 * One threshold evaluation, with the exact `.rfmedia.yaml` key behind it.
 *
 * `configPath` is what makes a verdict actionable: the operator reads the key
 * to edit straight off the report instead of re-deriving it from source.
 */
export interface PolicyThresholdCheck {
  readonly signal: PolicySignal | "derived";
  readonly label: string;
  readonly comparator: ">=" | "<=" | "==" | "!=";
  readonly bound: number | boolean | string | null;
  readonly observed: number | boolean | string | null;
  readonly satisfied: boolean;
  /** Dotted `.rfmedia.yaml` path, or null for a structural (non-configured) gate. */
  readonly configPath: string | null;
}

/** Inert follow-up. `argv` is a machine argument vector, never shell text. */
export interface PolicyHandoff {
  readonly producer: PolicyProducerId | "discovery";
  readonly argv: readonly string[];
}

/**
 * A stable, NON-ROTATING decision key.
 *
 * PROPOSAL format: `<ruleId>:artist:<lidarrId>` or `<ruleId>:plex:<plexId>` — a
 * rule proposes at most one change per subject.
 *
 * SKIP format: the same, plus the skip code as a fourth segment
 * (`<ruleId>:artist:<lidarrId>:<skipCode>` / `<ruleId>:plex:<plexId>:<skipCode>`).
 * Rule + subject alone is not total for refusals: one subject can draw both a
 * rule's own refusal and the §6.0 universal `identity-not-authoritative`
 * refusal, and without the code both rows would share a key.
 *
 * Deliberately not a content hash: a threshold edit must not silently invalidate
 * the key an operator just read out of a report.
 */
export type PolicyDecisionKey = string;

/** One proposed change. Constructible only via `createPolicyProposal`. */
export interface PolicyProposal {
  readonly key: PolicyDecisionKey;
  readonly ruleId: PolicyRuleId;
  readonly code: PolicyDecisionCode;
  readonly subject: PolicySubject;
  readonly identity: PolicyIdentityBasis;
  /** Flat scalar current state. */
  readonly before: Readonly<Record<string, string | number | boolean | null>>;
  /** Flat scalar desired state. */
  readonly after: Readonly<Record<string, string | number | boolean | null>>;
  /** Every threshold that produced this verdict, in evaluation order. */
  readonly checks: readonly PolicyThresholdCheck[];
  /** Per-signal observations, for provenance. */
  readonly observations: Readonly<Record<string, PolicyObservation<number | boolean>>>;
  readonly summary: string;
  readonly handoff: PolicyHandoff;
}

/** One refusal. Refusals are DATA, never omissions. */
export interface PolicySkip {
  readonly key: PolicyDecisionKey;
  readonly ruleId: PolicyRuleId;
  readonly code: PolicySkipCode;
  readonly subject: PolicySubject;
  readonly identity: PolicyIdentityBasis;
  readonly checks: readonly PolicyThresholdCheck[];
  readonly detail: string;
}

/** What one evaluator returns. */
export interface PolicyRuleVerdict {
  readonly proposals: readonly PolicyProposal[];
  readonly skips: readonly PolicySkip[];
}

/** Per-rule result. EVERY registered rule appears exactly once, always. */
export type PolicyRuleResult =
  | {
      readonly id: PolicyRuleId;
      readonly title: string;
      readonly status: "proposals";
      readonly proposedCount: number;
      readonly skippedCount: number;
    }
  | {
      readonly id: PolicyRuleId;
      readonly title: string;
      readonly status: "clean";
      readonly proposedCount: 0;
      readonly skippedCount: number;
    }
  | {
      readonly id: PolicyRuleId;
      readonly title: string;
      readonly status: "skipped";
      readonly skipReason: PolicyRuleSkipReason;
      readonly detail: string;
    };

/* ── Resolved policy (echoed in the report) ──────────────────────────────── */

export interface PolicyResolvedRatingQualityUpgrade {
  readonly kind: "rating-quality-upgrade";
  readonly enabled: boolean;
  /** 1-5 star input scale, converted by `evaluateMediaFilterRule`. */
  readonly minRating: number;
  readonly targetQualityProfile: string | null;
  readonly resolvedProfileId: number | null;
  readonly maxProposals: number;
}

export interface PolicyResolvedStaleMonitoring {
  readonly kind: "stale-monitoring-cleanup";
  readonly enabled: boolean;
  readonly maxPlays: number;
  /**
   * Star rating at or above which an artist is never unmonitored. ALWAYS
   * ACTIVE: the config schema admits a finite 1.0-5.0 value only, so there is
   * no disabling value and the resolver defaults to `4`.
   */
  readonly protectRatingAtOrAbove: number;
  readonly requireTrackCoverage: boolean;
  readonly minTrackFileCount: number;
  readonly maxProposals: number;
}

export interface PolicyResolvedDiscoverySeed {
  readonly kind: "discovery-seed";
  readonly enabled: boolean;
  readonly minRating: number;
  readonly minPlays: number | null;
  readonly maxSeeds: number;
}

export type PolicyResolvedRule =
  | PolicyResolvedRatingQualityUpgrade
  | PolicyResolvedStaleMonitoring
  | PolicyResolvedDiscoverySeed;

export interface PolicyResolvedPolicy {
  readonly plexLibrary: string;
  readonly rules: Readonly<Record<PolicyRuleId, PolicyResolvedRule>>;
}

/* ── Report ──────────────────────────────────────────────────────────────── */

export interface PolicyEvaluationSummary {
  readonly proposed: number;
  readonly skipped: number;
  readonly rulesRun: number;
  readonly rulesSkipped: number;
}

/** How much data actually backed the report. Derived from slots ALONE. */
export interface PolicyEvaluationCoverage {
  readonly plexArtistsExamined: number;
  readonly plexTracksExamined: number;
  readonly authoritativeLinks: number;
  readonly nonAuthoritativeArtists: number;
  /** Normalized names claimed by 2+ distinct Plex artists; both are poisoned. */
  readonly ambiguousNameArtists: number;
  /** Tracks bucketed under the `"Unknown Artist"` mapper sentinel. */
  readonly sentinelArtistTracks: number;
  /** Tracks whose normalized artist matched no bridge item. */
  readonly unjoinedTracks: number;
  /** Library-wide play total. Zero trips the per-account sanity gate. */
  readonly totalPlaysObserved: number;
}

/** Slot availability echoed verbatim so the report explains its own gaps. */
export type PolicySignalStatusMap = Readonly<
  Record<PolicySignal, { readonly status: "available" | "unavailable"; readonly detail?: string }>
>;

export interface PolicyEvaluationReport {
  readonly schema: typeof POLICY_EVALUATION_SCHEMA;
  readonly engineVersion: typeof POLICY_ENGINE_VERSION;
  readonly evaluatedAt: string;
  readonly plexOrigin: string;
  readonly lidarrOrigin: string;
  readonly plexLibrary: string;
  /** `degraded` > `proposals` > `clean`, in that precedence. */
  readonly status: "clean" | "proposals" | "degraded";
  readonly policy: PolicyResolvedPolicy;
  readonly signals: PolicySignalStatusMap;
  readonly summary: PolicyEvaluationSummary;
  readonly rules: readonly PolicyRuleResult[];
  readonly proposals: readonly PolicyProposal[];
  readonly skips: readonly PolicySkip[];
  readonly coverage: PolicyEvaluationCoverage;
}

/* ── Bounds ──────────────────────────────────────────────────────────────── */

export const POLICY_MAX_PROPOSALS_PER_RULE = 100;
/**
 * Bounds a rule's OWN skips, in emission order. The §6.0 universal refusals are
 * attached AFTER this truncation, so the refusal-owning rule may report up to
 * `500 + coverage.nonAuthoritativeArtists` skips and that coverage counter is
 * always the untruncated count. Refusals are data, never omissions.
 */
export const POLICY_MAX_SKIPS_PER_RULE = 500;
export const POLICY_HUMAN_ROW_CAP = 20;

/* ── Exit gate ───────────────────────────────────────────────────────────── */

export const POLICY_FAIL_ON_LEVELS = ["none", "proposals"] as const;
export type PolicyFailOn = (typeof POLICY_FAIL_ON_LEVELS)[number];

/**
 * Decides whether the command must set `process.exitCode = 1`.
 *
 * Lives here rather than in the engine so `src/commands/lidarr-policy.ts` can
 * apply the gate after rendering without statically importing the evaluator
 * graph. Semantics, in order: `none` never trips; a `degraded` report ALWAYS
 * trips at any non-`none` level; otherwise at least one proposal must exist.
 */
export function shouldFailPolicyEvaluation(report: PolicyEvaluationReport, failOn: PolicyFailOn): boolean {
  if (failOn === "none") {
    return false;
  }
  if (report.status === "degraded") {
    return true;
  }
  return report.summary.proposed > 0;
}

/** Narrowing guard for `--rule` parsing inside the action handler. */
export function isPolicyRuleId(value: string): value is PolicyRuleId {
  return (POLICY_RULE_IDS as readonly string[]).includes(value);
}
```

### 4.1 `src/lib/bridge/policy-rule-support.ts` — the sole proposal factory

```ts
/**
 * Shared evaluator primitives (role analogue of `src/lib/lidarr/audit-check-support.ts`).
 * Zero I/O. Nothing here may import a client, adapter, or database module.
 */

/** Builds the decision key for an authoritative link. */
export function policyArtistKey(ruleId: PolicyRuleId, lidarrId: number): PolicyDecisionKey;
/** Builds the decision key for a Plex-only subject. */
export function policyPlexKey(ruleId: PolicyRuleId, plexId: string): PolicyDecisionKey;

/**
 * THE ONLY proposal constructor for a mutation-bound proposal.
 *
 * Requires a `PolicyIdentityLink`, which only `indexAuthoritativeIdentities`
 * can mint. Freezes the proposal, its `checks`, `before`, `after`, and
 * `observations`.
 */
export function createPolicyProposal(input: {
  readonly ruleId: PolicyRuleId;
  readonly code: PolicyDecisionCode;
  readonly link: PolicyIdentityLink;
  readonly before: Readonly<Record<string, string | number | boolean | null>>;
  readonly after: Readonly<Record<string, string | number | boolean | null>>;
  readonly checks: readonly PolicyThresholdCheck[];
  readonly observations: Readonly<Record<string, PolicyObservation<number | boolean>>>;
  readonly summary: string;
  readonly handoff: PolicyHandoff;
}): PolicyProposal;

/**
 * Narrow constructor for an INERT seed, which has no Lidarr counterpart and
 * therefore no `PolicyIdentityLink`. `handoff.producer` is fixed to
 * `"discovery"`, so a seed can never be routed to a mutation producer.
 */
export function createPolicySeedProposal(input: {
  readonly subject: PolicySubject;
  readonly identity: PolicyIdentityBasis;
  readonly checks: readonly PolicyThresholdCheck[];
  readonly observations: Readonly<Record<string, PolicyObservation<number | boolean>>>;
  readonly summary: string;
  readonly seedArtistName: string;
}): PolicyProposal;

/** Skip constructor. Accepts a non-authoritative subject by design. */
export function createPolicySkip(input: {
  readonly ruleId: PolicyRuleId;
  readonly code: PolicySkipCode;
  readonly subject: PolicySubject;
  readonly identity: PolicyIdentityBasis;
  readonly checks?: readonly PolicyThresholdCheck[];
  readonly detail: string;
}): PolicySkip;

/**
 * The one argv builder — the pluggable action-emitter seam, deliberately a
 * function over a data table rather than an emitter framework.
 *
 * INVARIANT (test-enforced): the returned argv NEVER names "apply" or
 * "--plan-file" in a STRUCTURAL position — the leading verb segments and the
 * option names. Option VALUES are exempt, because they are library data: a Plex
 * artist or a Lidarr quality profile literally titled "apply" is a legal string,
 * and asserting on it would turn the whole rule into a `rule-error` skip and
 * delete every proposal it had made. Omitting `--plan-file` lets the existing
 * producer default to `defaultOutputPath` under `getDefaultPlanDir()`
 * (`~/.config/rfmedia/plans`, 0700/0600) instead of scattering artifacts into
 * whatever directory the operator happened to be standing in.
 */
export function buildPolicyHandoff(producer: PolicyProducerId | "discovery", args: readonly string[]): PolicyHandoff;

/** Unwraps a declared required slot; throwing means registry/evaluator disagree. */
export function requireSignal<T>(slot: PolicySignalSlot<T>, ruleId: PolicyRuleId, signal: PolicySignal): T;

/** Evaluates a star-scale rating threshold through the ONE shipped implementation. */
export function checkArtistRating(
  artist: MediaArtist,
  comparator: ">=" | "<=",
  starBound: number,
  configPath: string,
): PolicyThresholdCheck;
```

`checkArtistRating` constructs a `MediaFilterRule` and delegates to `evaluateMediaFilterRule` (`src/lib/media-filter-evaluator.ts:141`). This inherits both the star→normalized conversion and the `rating === null → undefined → false` fail-closed semantic instead of re-implementing them (`starRatingToNormalized` lives in `src/lib/adapters/plex/mappers.ts:109`, behind the architecture gate and unreachable).

> **Hard constraint:** only `">="` and `"<="` may ever be constructed. `evaluateMediaFilterRule` returns **`true`** for `"!="` / `"not_contains"` when the field value is `undefined` (`media-filter-evaluator.ts:143-145`), which would invert the fail-closed property on an unrated artist. `checkArtistRating`'s comparator parameter is typed `">=" | "<="` precisely so this cannot happen.

---

## 5. Config schema

### 5.1 Types — `src/types/config.ts`

```ts
/** Configuration for the fixed `rating-quality-upgrade` policy rule. */
export interface PolicyRatingQualityUpgradeConfigOptions {
  /** Whether the rule participates in an evaluation. */
  readonly enabled?: boolean;
  /** Plex artist rating floor on the 1-5 star input scale. */
  readonly minRating?: number;
  /** Existing Lidarr quality profile, by name or numeric id. */
  readonly targetQualityProfile?: string;
  /** Per-rule proposal cap. */
  readonly maxProposals?: number;
}

/** Configuration for the fixed `stale-monitoring-cleanup` policy rule. */
export interface PolicyStaleMonitoringConfigOptions {
  readonly enabled?: boolean;
  /** Inclusive total-play ceiling. Absolute count, NOT recency. */
  readonly maxPlays?: number;
  /** Star rating at or above which an artist is never unmonitored. */
  readonly protectRatingAtOrAbove?: number;
  /** Require at least one Plex track to have joined this artist. */
  readonly requireTrackCoverage?: boolean;
  /** Minimum Lidarr `statistics.trackFileCount` to consider the artist acquired. */
  readonly minTrackFileCount?: number;
  readonly maxProposals?: number;
}

/** Configuration for the fixed `discovery-seed` policy rule. */
export interface PolicyDiscoverySeedConfigOptions {
  readonly enabled?: boolean;
  readonly minRating?: number;
  readonly minPlays?: number;
  readonly maxSeeds?: number;
}

/** The three fixed policy rules. Unknown rule ids are rejected. */
export interface PolicyRulesConfigOptions {
  readonly "rating-quality-upgrade"?: PolicyRatingQualityUpgradeConfigOptions;
  readonly "stale-monitoring-cleanup"?: PolicyStaleMonitoringConfigOptions;
  readonly "discovery-seed"?: PolicyDiscoverySeedConfigOptions;
}

/** Consumption-driven Lidarr policy engine options. */
export interface PolicyConfigOptions {
  /** Plex music library consumption signals are read from. */
  readonly plexLibrary?: string;
  readonly rules?: PolicyRulesConfigOptions;
}
```

Add to `ConfigFile` (`src/types/config.ts:23-52`), immediately after `discovery`:

```ts
  /** Consumption-driven Lidarr policy engine options */
  policy?: PolicyConfigOptions;
```

Re-export all five types from the `src/types/index.ts` config barrel (lines 95-125).

### 5.2 Validator — inline in `src/lib/config.ts`

Follows `validateDiscoveryConfigOptions` (`config.ts:2626`) verbatim in shape. Strict at every level.

```ts
const POLICY_CONFIG_KEYS = new Set(["plexLibrary", "rules"]);
const POLICY_RULE_IDS_SET = new Set(["rating-quality-upgrade", "stale-monitoring-cleanup", "discovery-seed"]);
const POLICY_QUALITY_UPGRADE_KEYS = new Set(["enabled", "minRating", "targetQualityProfile", "maxProposals"]);
const POLICY_STALE_MONITORING_KEYS = new Set([
  "enabled",
  "maxPlays",
  "protectRatingAtOrAbove",
  "requireTrackCoverage",
  "minTrackFileCount",
  "maxProposals",
]);
const POLICY_DISCOVERY_SEED_KEYS = new Set(["enabled", "minRating", "minPlays", "maxSeeds"]);

const POLICY_MAX_PLAYS_CEILING = 1_000_000;
const POLICY_MAX_PROPOSALS_CEILING = 100;
const POLICY_MAX_SEEDS_CEILING = 100;
const POLICY_MAX_TRACK_FILE_COUNT = 1_000_000;
```

Rules:

- `rejectUnknownConfigKeys(raw, KEYS, propertyPath, configPath)` is called **first** at every object level, including `policy.rules` against `POLICY_RULE_IDS_SET` — a typo'd rule id throws instead of silently disabling enforcement.
- Ratings go through the existing `validateStarRating` (`config.ts:410`), which requires a **finite** number in 1.0–5.0 — YAML `.nan` and `.inf` parse as JS numbers and are rejected.
- Counts go through `validateBoundedInteger` with the named ceilings above.
- Booleans go through `validateBoolean`. `targetQualityProfile` goes through `validateQualityProfileReference`, which applies the same non-empty-string rule and additionally accepts a positive safe-integer profile id, normalising it with `String(...)` so the stored type stays `string` per §5.1.
- Presence test is always `if ("x" in raw && raw["x"] !== undefined)` — never truthiness (would drop `false` / `0`).
- **No defaults are injected.** The validator returns only what the operator supplied; defaults are applied at the consumption site by `resolvePolicyConfig` (the `resolveLidarrCascadePolicy` pattern, `src/lib/lidarr/cascade-analysis.ts:145`).

Registration — the **single** hook point, inside `validateConfig` (`config.ts:3911-4092`), immediately after the `discovery` branch at `:3988`:

```ts
if ("policy" in rawObj && rawObj["policy"] !== undefined) {
  if (typeof rawObj["policy"] !== "object" || rawObj["policy"] === null || Array.isArray(rawObj["policy"])) {
    throw new ConfigError("policy must be an object", configPath, "policy");
  }
  config.policy = validatePolicyConfigOptions(rawObj["policy"] as Record<string, unknown>, configPath);
}
```

> A section declared in `types/config.ts` with no branch here is **silently dropped at load** — the shipped bug class behind `plex.pageSize`, `syncRatingsOnCopy`, and `syncOnCopyDefaults`. The `it.each` rejection table in §14.5 is what guards it.

`buildConfigTemplate` is **not** touched: it feeds `yaml.dump` and cannot carry comments, and an uncommented empty `policy:` skeleton in every generated config is worse than none. `config-init-merge.test.ts` expectations are unchanged.

Add `getLoadedPolicyConfig(): PolicyConfigOptions | undefined` to `src/lib/loaded-config.ts` alongside `getLoadedPlexConfig` / `getLoadedLidarrConfig`, so the action reads policy config without importing `config.ts` and risking an ESM cycle.

### 5.3 Complete commented YAML example

```yaml
# .rfmedia.yaml — consumption-driven Lidarr policy engine (issue #209).
#
# Every key is optional. Unknown keys — including an unknown RULE ID — are
# rejected with a ConfigError carrying an exact dotted propertyPath, e.g.
#   policy.rules.stale-monitoring-cleanup.maxPlays
# so a typo cannot silently disable a rule.
#
# Rating values use the SAME 1-5 star input scale as the `filters:` section.
# Plex native 0 means UNRATED, which is "no signal", never "zero stars" — an
# unrated artist is SKIPPED, never treated as low-rated.
#
# `{{ VAR }}` template substitution works here for free (raw-text pre-parse),
# but no field in this section is a credential: policy reads Plex and Lidarr
# through the existing `plex.*` / `lidarr.*` sections.

policy:
  # Plex music library consumption signals are read from.
  # Overridable per invocation with --plex-library.
  plexLibrary: "Music"

  rules:
    # ── 1. Rating-informed quality upgrade ───────────────────────────────────
    # Promote artists you demonstrably love to a better quality profile.
    # Proposes an `artist-profile-assignment` change; never deletes anything.
    rating-quality-upgrade:
      enabled: true # default: false
      minRating: 4 # 1-5 stars.        default: 4
      # Existing Lidarr quality profile, by name or numeric id. Resolved live
      # against client.listQualityProfiles(). When the configured name resolves
      # to nothing, the rule is skipped: a rule-level skip carries the configured
      # name plus the available profile names, and the report status becomes
      # `degraded`. It never throws and never suppresses sibling rules (§16.1).
      # REQUIRED when the rule is enabled.
      targetQualityProfile: "Lossless"
      maxProposals: 25 # 1-100.            default: 25

    # ── 2. Stale monitoring cleanup ──────────────────────────────────────────
    # Unmonitor artists Lidarr is tracking that show no Plex consumption.
    # Proposes `artist-monitoring` (desiredMonitored: false). FULLY REVERSIBLE:
    # files are never touched. This is the only rule with real blast radius —
    # read the four safety gates below before enabling it.
    stale-monitoring-cleanup:
      enabled: false # default: false. Opt in deliberately.

      # Inclusive ceiling on the artist's TOTAL Plex play count.
      # NOTE: absolute plays, NOT recency. The media-server domain has no
      # lastViewedAt field, so this rule cannot express "not played lately".
      maxPlays: 0 # 0-1000000.        default: 0

      # SAFETY GATE 1 — rating veto. An artist rated AT OR ABOVE this is never
      # unmonitored, regardless of play count. ALWAYS ACTIVE: the schema admits
      # a finite 1.0-5.0 value only, so there is no disabling value. The
      # narrowest setting is 5. Writing `null` fails validation, and loadConfig
      # then falls back to an EMPTY config — discarding this whole file.
      protectRatingAtOrAbove: 4 # 1-5 stars.        default: 4

      # SAFETY GATE 2 — coverage. Require at least one Plex track to have
      # actually joined this artist. Without it, "no plays observed" could be
      # read as "not consumed" when the truth is "the artist is not in Plex".
      requireTrackCoverage: true # default: true. Leave it true.

      # SAFETY GATE 3 — acquisition. Only consider artists Lidarr already has
      # this many files for, so an artist still in the acquisition queue is
      # never unmonitored out of it. An artist whose Lidarr `statistics` block
      # is absent (freshly added / unscanned) is SKIPPED, not treated as zero.
      minTrackFileCount: 1 # 0-1000000.        default: 1

      # SAFETY GATE 4 (structural, not configurable) — the rule refuses to run
      # at all when the library-wide play total is zero, which is the signature
      # of a token whose Plex account is not the listening account.

      maxProposals: 25 # 1-100.            default: 25

    # ── 3. Discovery seed generation ─────────────────────────────────────────
    # Emits INERT `lidarr discover --artist "<name>"` seeds. Produces no plan,
    # no add, and makes no provider call.
    discovery-seed:
      enabled: false # default: false
      minRating: 5 # 1-5 stars.        default: 5
      minPlays: 25 # omit to rank on rating alone. no default
      maxSeeds: 10 # 1-100.            default: 10
```

---

## 6. The three policies

All three iterate `report.matchedExact` only (except `discovery-seed`, see 6.3). Skips are emitted in the fixed `POLICY_SKIP_ORDER` precedence, so the reported code is always the **first** blocking cause.

### 6.0 Universal refusal (emitted by `indexAuthoritativeIdentities`, once, not per rule)

Every item in `report.reviewSuggested`, `report.reviewAmbiguous`, `report.plexOnly`, `report.lidarrOnly`, `report.conflicts`, and `report.unavailable` yields a `PolicySkip` with code `identity-not-authoritative` and `detail: "review-grade name evidence is never auto-consumed by a policy decision"`. Only `matchedExact` mints a `PolicyIdentityLink`.

`report.lidarrOnly` (`ReconciliationTargetUnmatchedItem`) is additionally **hard-refused** by `stale-monitoring-cleanup` with `no-consumption-coverage`: an artist with no Plex counterpart at all has produced _no evidence_, and absence of evidence is not evidence of non-consumption.

### 6.1 `rating-quality-upgrade`

|                |                                                                                 |
| -------------- | ------------------------------------------------------------------------------- |
| **Requires**   | `bridgeIdentity`, `lidarrArtists`, `lidarrQualityProfiles`, `plexArtistRatings` |
| **Enriches**   | `plexTrackPlays` (shown as context, never gates)                                |
| **Candidates** | `report.matchedExact`                                                           |

Per link, in order:

1. `LidarrArtist` present for `link.lidarrId`? No → skip `signal-unavailable`.
2. `MediaArtist` present for `link.plexId`? No → skip `signal-unavailable` (`no-plex-artist`).
3. `checkArtistRating(artist, ">=", minRating, "policy.rules.rating-quality-upgrade.minRating")`. Unrated (`rating === null`) → check `satisfied: false`, `observed: null` → skip `signal-unavailable` (`unrated`). Below floor → skip `signal-unavailable` with the check attached.
4. `qualityProfileId !== resolvedProfileId`? Equal → skip `already-converged`.
5. Otherwise **propose**.

```
code      rating-below-target-profile
before    { qualityProfileId: 2, qualityProfileName: "Standard" }
after     { qualityProfileId: 6, qualityProfileName: "Lossless" }
handoff   artist-profile-assignment
          ["lidarr","plan","artist-profiles","--ids","41,88,102",
           "--quality-profile","Lossless"]
```

### 6.2 `stale-monitoring-cleanup`

|                |                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Requires**   | `bridgeIdentity`, `lidarrArtists`, `plexTrackPlays`                                                                            |
| **Enriches**   | `plexArtistRatings` (used by the rating veto; when unavailable the veto cannot be evaluated and the rule refuses — see step 4) |
| **Candidates** | `report.matchedExact` only                                                                                                     |

**Rule-level gate (before any candidate):** if `coverage.totalPlaysObserved === 0`, the whole rule skips with `PolicyRuleSkipReason: "consumption-signal-empty"` and detail _"library-wide Plex play total is zero; the resolved Plex token's account may not be the listening account"_. This is the per-account `viewCount` sanity gate (§9.1).

Per link, in order:

1. `LidarrArtist` present? No → skip `signal-unavailable`.
2. `monitored === true`? No → skip `already-converged`.
3. Play observation: `lookupArtistPlays(playIndex, link)`.
   - `ambiguous-name-join` (normalized name claimed by 2+ Plex artists) → skip `ambiguous-name-join`.
   - `sentinel-artist-name` (the `"Unknown Artist"` bucket) → skip `ambiguous-name-join`.
   - `no-track-coverage` and `requireTrackCoverage === true` → skip `no-consumption-coverage`.
4. Rating veto — unconditional (there is no disabling value):
   - `plexArtistRatings` slot unavailable → skip `signal-unavailable` (the veto cannot be evaluated, so the rule refuses rather than proceeding blind).
   - `checkArtistRating(artist, ">=", protectRatingAtOrAbove, "policy.rules.stale-monitoring-cleanup.protectRatingAtOrAbove")` satisfied → skip `rating-protected`.
5. Acquisition gate — `minTrackFileCount > 0`:
   - `LidarrArtist.statistics === undefined` → skip `signal-unavailable` (`lidarr-statistics-absent`). **Never read as zero.**
   - `statistics.trackFileCount < minTrackFileCount` → skip `no-consumption-coverage`.
6. `plays <= maxPlays`? No → skip `signal-unavailable` with the check attached.
7. Otherwise **propose**.

```
code      monitored-artist-unconsumed
before    { monitored: true }
after     { monitored: false }
handoff   artist-monitoring
          ["lidarr","plan","artist-monitoring","--ids","233,417","--unmonitored"]
```

### 6.3 `discovery-seed`

|                |                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| **Requires**   | `bridgeIdentity`, `plexArtistRatings`                                                                       |
| **Enriches**   | `plexTrackPlays`                                                                                            |
| **Candidates** | `report.plexOnly` filtered to `ReconciliationSourceUnmatchedItem` with **`reason === "no-candidate"` only** |

> This filter is deliberate. `ReconciliationPlexOnlyItem` (`src/types/bridge.ts:497`) is a union that also contains review-normalized-name, review-fuzzy-name, ambiguous, conflict, and unavailable items — all of which _probably already exist in Lidarr under a slightly different name_. Seeding from them would generate noise and would contradict the authoritative-only invariant. `no-candidate` means the resolver found nothing at all, which is the only honest "absent from Lidarr" signal.

Per candidate: rating check against `minRating`, optional plays check against `minPlays` (an unavailable play observation skips when `minPlays` is set, is ignored when it is not), rank by `(rating desc, plays desc, plexId asc)`, cap at `maxSeeds`.

```
code      high-signal-discovery-seed
before    { inLidarr: false }
after     { inLidarr: false }          # inert; nothing changes
handoff   discovery
          ["lidarr","discover","--artist","Duster"]
```

Seeds carry **no `PolicyIdentityLink`** (there is no Lidarr counterpart). They go through `createPolicySeedProposal`, whose `handoff.producer` is fixed to `"discovery"` and whose `PolicySubject.artistId` is absent — the type prevents a seed from ever being routed to a mutation producer.

---

## 7. Dry-run / mutation boundary

### 7.1 How evaluation stays non-mutating

1. **No writer is imported.** `writeLidarrPlanArtifact`, `appendLidarrPlanHistory`, and `acquireLidarrPlanClaim` appear in no new module.
2. **No mutation method is called.** Only `client.listArtists(signal)` and `client.listQualityProfiles(signal)` — both reads — plus `adapter.query.artists` / `adapter.query.tracks`. No module needs registering in any `LIDARR_MUTATION_OWNERSHIP_RULES` owners `Set`.
3. **No Plex write.** `adapter.metadata` is never referenced.
4. **The only write in the whole flow** is the observational `bridge_identity_snapshots` replace performed _inside_ the reused `executeLidarrReconcile` — pre-existing read-path behavior, unchanged.
5. **`handoff.argv` is inert data**, following the `ReconciliationSuggestion` precedent (machine argument vectors, never executable shell text). A test pins that no argv names `"apply"` or `"--plan-file"` in a **structural** position (leading verb segments, option names). Option values are exempt: they carry library data, and a Plex artist or quality profile titled `"apply"` must not blow up the rule.
6. There is no `--dry-run` flag, because offering one would imply a non-dry mode exists.

### 7.2 How an operator proceeds to apply — three separate human-initiated steps

```bash
# Step 1 — read-only. Writes nothing.
rfmedia lidarr policy evaluate

# Step 2 — the operator runs an EXISTING producer, which reads FRESH live state
#          and seals a checksummed v3 artifact under ~/.config/rfmedia/plans.
#          The id list came from step 1; ids you disagree with can be deleted.
rfmedia lidarr plan artist-monitoring --ids 233,417 --unmonitored

# Step 3 — the existing sealed apply lifecycle, with its own authorization.
rfmedia lidarr apply --plan-file ~/.config/rfmedia/plans/lidarr-<stamp>-<id8>.json --yes
```

Step 2 re-reads live state, so a stale id list produces a converged no-op entry rather than a wrong mutation. Step 3 retains drift preflight, resume, history, exclusive claims, and the double-enforced `--allow-*` authorization — none of which this issue touches.

---

## 8. Evidence handling

### 8.1 Never-throw gathering — `src/actions/lidarr/policy-gather.ts`

Every gatherer copies `probeLidarrAuditPlex` (`src/actions/lidarr/audit-plex.ts:116-178`):

1. Readiness gate first (URL present **and** a credential source: static token **or** `plexAuthStoreExistsSync`) → `{ status: "unavailable", reason: "plex-not-configured" }`.
2. Adapter constructed **inside** the same `try` as the round trips it enables.
3. **RAW `{ plexUrl, plexToken }` overrides forwarded** straight to the factory. Pre-resolving them against config structurally disables the frozen cross-origin credential guard (whose condition is a presence test on the raw override object).
4. Every failure converted to `{ status: "unavailable", reason: "data-unavailable", detail }` carrying a `MediaServerErrorCode` — never rethrown.
5. Drains use the mandatory loop; never hand-rolled `offset += limit`:

```ts
let offset = 0;
for (;;) {
  signal?.throwIfAborted();
  const page = await adapter.query.tracks({
    library,
    kind: "track",
    limit: POLICY_GATHER_PAGE_SIZE,
    offset,
  });
  signal?.throwIfAborted();
  collect(page.items);
  const next = advancePaginationOffset(page, "Plex tracks");
  if (next === offset) break;
  offset = next;
}
```

6. Hard bounds `POLICY_MAX_PLEX_ARTISTS = 10_000` and `POLICY_MAX_PLEX_TRACKS = 200_000`. Exceeding either **fails closed** (unavailable slot with a bounded detail), never truncates. `POLICY_GATHER_PAGE_SIZE = 500` rather than the adapter default of 100.
7. **Only signals in `requiredSignalsFor(selected) ∪ enrichedSignalsFor(selected)` are gathered.** As shipped this buys nothing for `plexTrackPlays`: `stale-monitoring-cleanup` **requires** it and both `rating-quality-upgrade` and `discovery-seed` **enrich** with it, so the plan contains it for every possible `--rule` selection. `--rule` narrows which rules EVALUATE, never the track drain; `plex.cache.enabled: true` is the only lever on that cost. The union rule stays as the structural contract for any future rule that touches neither.

### 8.2 The two joins

**Ratings — exact id join.** `MediaArtist.id === ReconciliationSourceIdentity.plexId`. Verified sound: `mapPlexArtist` sets `id: artist.ratingKey` (`plex/mappers.ts:172`) and `projectArtist` sets `id: wire.ratingKey` (`plex/identity.ts:102`). Join grade `exact-plex-id`. `rating === null` means **unrated** (Plex native 0 → `null` via `plexNativeRatingToNormalized`) and is distinct from a low rating.

**Play totals — normalized-name rollup (the weak seam).** `MediaTrack` carries `artist: string` with no artist id, and `playCount` exists only on `MediaTrack`, so no id path exists. Tracks are bucketed under `normalizeBridgeArtistName(track.artist)` — **reusing** the versioned normalizer (`src/lib/bridge/artist-name.ts:5`) rather than inventing a second normalization policy, so the join inherits `BRIDGE_ARTIST_NORMALIZATION_VERSION`. Join grade `normalized-name`.

Three fail-closed poisonings:

| Condition                                                            | Result                                                                                             |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| A normalized key claimed by **2+ distinct Plex artist ids**          | Both artists' play observation → `ambiguous-name-join`; counted in `coverage.ambiguousNameArtists` |
| A track bucketed under `normalizeBridgeArtistName("Unknown Artist")` | That key is **permanently poisoned**; counted in `coverage.sentinelArtistTracks`                   |
| A track whose normalized artist matches no bridge item               | Counted in `coverage.unjoinedTracks`; never silently dropped                                       |

> The sentinel poisoning is not optional. `mapPlexTrack` sets `artist: track.grandparentTitle ?? "Unknown Artist"` (`plex/mappers.ts:141`), so every track lacking a grandparent title collapses into one bucket. Without poisoning, plays would be inflated for any artist whose title normalizes to that string, **and** the real artists behind those orphaned rows would appear to have zero plays — pushing them toward an unmonitor proposal.

### 8.3 Low-confidence identity

Only `report.matchedExact` (unique one-to-one exact artist-MBID, `reason: "unique-exact-mbid"`, `method: "exact-mbid"`) mints a `PolicyIdentityLink`. `createPolicyProposal` requires one. Review-normalized-name, review-fuzzy-name, ambiguous, conflict, and unavailable items are enumerated as `identity-not-authoritative` skips. **This is a compile-time property, not a review convention.**

### 8.4 Missing Lidarr statistics

`LidarrArtist.statistics` is **optional** (`src/types/lidarr.ts:181`: "Lidarr may omit it for freshly-added or unscanned artists"). Under `noUncheckedIndexedAccess` and `strict`, the acquisition gate resolves an absent block to `PolicyObservation { status: "unavailable", reason: "lidarr-statistics-absent" }` → skip `signal-unavailable`. It is **never** coerced to `0`, which would make the gate fail open on exactly the freshly-added artists it exists to protect.

### 8.5 Offline snapshots

Not supported. `--offline` is not offered and `--plex-library-id` is rejected. The bridge snapshot stores only `plexId / title / state / reason / method / candidates` plus `BridgeTargetArtist { lidarrId, title, artistMbid }` — **zero consumption evidence** — so an offline run could emit nothing but skips. Failing closed with a typed error beats shipping a degenerate mode. `resolveOfflineReconcileOrigins` and `isCredentialFreeOfflineReconcile` are untouched.

### 8.6 Unmapped artists

| Situation                                                 | Handling                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Plex artist with no Lidarr match                          | `identity-not-authoritative` skip; eligible for `discovery-seed` only when `reason === "no-candidate"` |
| Lidarr artist with no Plex match (`lidarrOnly`)           | `no-consumption-coverage` skip. **Never unmonitored.**                                                 |
| Bridge `plexId` with no `MediaArtist` in the rating index | `no-plex-artist` → `signal-unavailable` skip                                                           |
| Bridge link with no `LidarrArtist` in the list            | `signal-unavailable` skip                                                                              |

### 8.7 Engine-level degradation

Cloned from `runLidarrAudit`:

- **Every registered rule appears in `report.rules` exactly once, always** — even when deselected or ungathered. A `--json` consumer keys on ids without probing.
- A required slot that is `unavailable` with `reason: "data-unavailable"` sets `degraded`; expected absences (`not-requested`, `plex-not-configured`) do not.
- A throwing evaluator costs exactly one rule: `PolicyRuleSkipReason: "rule-error"` with a bounded message. The report degrades; **every sibling rule still runs**.
- Status precedence: `degraded` > `proposals` > `clean`.
- Deterministic total order: rule declaration order, then `lidarrId` asc, then `plexId` asc. The whole report is deep-frozen.

---

## 9. Known hazards and their mitigations

### 9.1 `viewCount` is per-Plex-account (unavoidable — mitigated, not solved)

`MediaTrack.playCount` derives from `PlexWireTrack.viewCount` (`plex/mappers.ts:143`), which is the view count **for the account behind the resolved token**. A run under an admin/service token while listening happens under a managed user sees `playCount: 0` for the entire library, and `stale-monitoring-cleanup` would propose unmonitoring everything that matched exactly.

Mitigations, layered:

1. **Structural gate:** the rule refuses to run when `coverage.totalPlaysObserved === 0`, with `consumption-signal-empty` and a detail naming the token-account hypothesis. This catches the pure case.
2. `coverage.totalPlaysObserved` is printed in the human header and carried in the machine envelope on every run, so a partially-wrong account is visible as an implausibly low total.
3. The rule is disabled by default and `maxProposals` defaults to 25.
4. The proposal is `artist-monitoring`, verified `level: "low", destructive: false` in `plan-operation-definitions.ts:210-218` ("Existing files remain unchanged") — fully reversible.
5. The feature doc carries an explicit **"Which Plex account do the play counts come from?"** section.

### 9.2 No recency dimension (unavoidable — documented)

`lastViewedAt`, `skipCount`, and `lastRatedAt` do not exist anywhere in the codebase, and `addedAt` exists only on playlists/collections. "Stale" therefore means low absolute play count, which will misfire on a recently-added, not-yet-played artist. Mitigated by `maxPlays: 0` default, the `minTrackFileCount` acquisition gate, and blunt statement in both the rule's `description` string and the feature doc. Adding recency is a coordinated four-to-seven-layer change and belongs to #210.

### 9.3 Full-library track drain cost

`plex.cache.enabled` defaults to `false`, so nothing is free. Mitigated by page size 500, hard bounds that fail closed, and `signal?.throwIfAborted()` around every await so Ctrl-C is immediate. `requires`/`enriches`-driven gathering is the structural mechanism, but with the three shipped rules it removes no track pages, because every one of them requires or enriches on `plexTrackPlays`. The feature doc therefore states plainly that a full evaluation is expensive, that `--rule` is **not** a cost lever, and that `plex.cache.enabled: true` is the only lever for repeated runs.

### 9.4 Six-file registration lockstep

| File                                                | Change                                                                        |
| --------------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/commands/lidarr.ts:1449-1494`                  | `addCommand` at index **7**, immediately after `createLidarrReconcileCommand` |
| `src/commands/lidarr.test.ts:25`                    | `"policy"` inserted after `"reconcile"` in `LIDARR_COMMAND_NAMES`             |
| `src/lib/shell-completions/bash.ts`                 | 5 edit sites                                                                  |
| `src/lib/shell-completions/zsh.ts`                  | 2 edit sites                                                                  |
| `src/lib/shell-completions/fish.ts`                 | 3 edit sites                                                                  |
| `src/lib/shell-completions/templates.spec.ts:45-64` | `lidarrCommandTree.lidarr` + nested `policy: ["evaluate"]`                    |

A mismatch fails the suite with a diff pointing at the completion templates rather than the cause. Do all six in one commit.

---

## 10. CLI surface

### 10.1 Command tree

`policy` is a parent with one leaf today (the two-level shape `presets` already uses), so a future `policy plan` needs no rename.

```
Usage: rfmedia lidarr policy [options] [command]

Translate Plex consumption signals into proposed Lidarr actions (never mutates)

Commands:
  evaluate [options]  Evaluate consumption policy rules and report proposals
```

```
Usage: rfmedia lidarr policy evaluate [options]

Evaluate consumption policy rules and report proposals. Read-only: this command
writes nothing to Plex, to Lidarr, or to the plan directory.

Selection:
  --plex-library <name>   Plex music library (overrides policy.plexLibrary)
  --rule <ids>            Comma-separated rule ids (repeatable). Values:
                          rating-quality-upgrade, stale-monitoring-cleanup,
                          discovery-seed. Default: every enabled rule.
  --max-proposals <n>     Per-rule proposal cap override (1-100)
Output:
  --explain <key>         Print one decision's full causal chain. Keys are
                          printed on every row, e.g.
                          stale-monitoring-cleanup:artist:233
  --fail-on <level>       Exit 1 when proposals exist: none|proposals (default: none)
  -v, --verbose           Show every row instead of the first 20
Connection:
  --plex-url <url>        Plex base URL (overrides config)
  --plex-token <token>    Plex token (overrides config)
  --lidarr-url <url>      Lidarr base URL (overrides config)
  --lidarr-api-key <key>  Lidarr API key (overrides config)
```

Root `--output <json|yaml|csv|table|text>` and `--json` are declared on the root program and reconciled by the `cli.ts` `preAction` hook; the leaf reads them via `deps.resolveFormat()` and **must not redeclare them**.

> `--rule` uses a **non-throwing accumulator** `argParser` modeled on `parseAuditCheckIds` (`src/commands/lidarr-audit.ts:164`). Validation happens inside the action handler. A Commander `argParser` that throws `InvalidArgumentError` calls `process.exit(1)` **before** `.action()` runs, bypassing the failure envelope, redaction, and every test.

### 10.2 Human output — stderr only (stdout stays clean for `| jq`)

```text
$ rfmedia lidarr policy evaluate
Consumption policy evaluation — Music @ https://plex.example.net
  Evaluated 2026-07-28T18:04:11Z · engine v1 · status: proposals

  Rule                      Status     Proposed  Skipped
  rating-quality-upgrade    proposals         3       12
  stale-monitoring-cleanup  proposals         2        9
  discovery-seed            skipped           -        -
                            └ disabled in policy.rules.discovery-seed.enabled

  Proposals (5)
  Key                                   Artist            Because                Before      After
  rating-quality-upgrade:artist:41      Radiohead         rating 5 >= 4          Standard    Lossless
  rating-quality-upgrade:artist:88      Portishead        rating 4 >= 4          Standard    Lossless
  rating-quality-upgrade:artist:102     Massive Attack    rating 5 >= 4          Standard    Lossless
  stale-monitoring-cleanup:artist:233   Generic Chillhop  0 plays <= 0, unrated  monitored   unmonitored
  stale-monitoring-cleanup:artist:417   Untitled Mixtape  0 plays <= 0, unrated  monitored   unmonitored

  Suggested follow-up
    Review a quality-profile change for 3 artist(s)
      rfmedia lidarr plan artist-profiles --ids 41,88,102 --quality-profile Lossless
    Review unmonitoring 2 unconsumed artist(s)
      rfmedia lidarr plan artist-monitoring --ids 233,417 --unmonitored

  Skipped (21) — rerun with --verbose to show all
    identity-not-authoritative  18  review-grade name evidence is never auto-consumed
    signal-unavailable           2  artist is unrated in Plex
    ambiguous-name-join          1  two Plex artists share a normalized name

  Policy    minRating 4 · maxPlays 0 · protectRatingAtOrAbove 4 · minTrackFileCount 1
  Signals   bridgeIdentity ok · lidarrArtists ok · lidarrQualityProfiles ok
            plexArtistRatings ok · plexTrackPlays ok
  Coverage  604 Plex artists · 18,220 tracks · 18,204 plays observed
            586 authoritative links · 18 non-authoritative
            1 ambiguous name · 12 sentinel-artist tracks · 4 unjoined tracks
  Explain   rfmedia lidarr policy evaluate --explain <key>

  Evaluation is read-only. No plan artifact was written and nothing was changed.
```

Zero-config first run (self-teaching — every registered rule always appears):

```text
$ rfmedia lidarr policy evaluate
Consumption policy evaluation — Music @ https://plex.example.net
  No proposals across 3 rule(s).

  Rule                      Status   Why
  rating-quality-upgrade    skipped  disabled in policy.rules.rating-quality-upgrade.enabled
                                     Highly rated Plex artists whose Lidarr quality profile
                                     is not the configured target
  stale-monitoring-cleanup  skipped  disabled in policy.rules.stale-monitoring-cleanup.enabled
                                     Monitored Lidarr artists with no demonstrated Plex
                                     consumption (absolute plays, NOT recency)
  discovery-seed            skipped  disabled in policy.rules.discovery-seed.enabled
                                     High-signal Plex artists with no Lidarr candidate at
                                     all, offered as seeds

  Configure rules under `policy:` in .rfmedia.yaml.
  See: packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md
```

`--explain`:

```text
$ rfmedia lidarr policy evaluate --explain stale-monitoring-cleanup:artist:233

  Decision stale-monitoring-cleanup:artist:233         outcome: proposed
  Rule     Stale monitoring cleanup                    code: monitored-artist-unconsumed
  Subject  Generic Chillhop  (plex 29104 · lidarr 233 · mbid c8da2e40-…)

  Identity evidence
    category authoritative · reason unique-exact-mbid
    Only a unique one-to-one exact artist-MBID join may carry a proposal.

  Observations
    plays          0     join normalized-name    n=31 tracks
    rating         —     join exact-plex-id      (unrated)
    monitored      true  join exact-artist-mbid
    trackFileCount 22    join exact-artist-mbid

  Threshold checks
    monitored       ==  true  observed true  SATISFIED   (structural gate)
    track coverage  >=  1     observed 31    SATISFIED
        policy.rules.stale-monitoring-cleanup.requireTrackCoverage
    artistRating    >=  4     observed null  NOT MET -> not protected
        policy.rules.stale-monitoring-cleanup.protectRatingAtOrAbove
    trackFileCount  >=  1     observed 22    SATISFIED
        policy.rules.stale-monitoring-cleanup.minTrackFileCount
    plays           <=  0     observed 0     SATISFIED
        policy.rules.stale-monitoring-cleanup.maxPlays

  Proposal
    artist-monitoring · artistId 233 · monitored true -> false

  Follow-up (inert; nothing is executed)
    rfmedia lidarr plan artist-monitoring --ids 233 --unmonitored
```

### 10.3 Machine output — stdout, full envelope even when empty

```json
{
  "command": "lidarr-policy-evaluate",
  "result": {
    "schema": "rfmedia.lidarr-consumption-policy.v1",
    "engineVersion": 1,
    "evaluatedAt": "2026-07-28T18:04:11.000Z",
    "plexOrigin": "https://plex.example.net",
    "lidarrOrigin": "https://lidarr.example.net",
    "plexLibrary": "Music",
    "status": "proposals",
    "policy": {
      "plexLibrary": "Music",
      "rules": {
        "stale-monitoring-cleanup": {
          "kind": "stale-monitoring-cleanup",
          "enabled": true,
          "maxPlays": 0,
          "protectRatingAtOrAbove": 4,
          "requireTrackCoverage": true,
          "minTrackFileCount": 1,
          "maxProposals": 25
        }
      }
    },
    "signals": {
      "bridgeIdentity": { "status": "available" },
      "lidarrArtists": { "status": "available" },
      "lidarrQualityProfiles": { "status": "available" },
      "plexArtistRatings": { "status": "available" },
      "plexTrackPlays": { "status": "available" }
    },
    "summary": { "proposed": 5, "skipped": 21, "rulesRun": 2, "rulesSkipped": 1 },
    "rules": [
      {
        "id": "rating-quality-upgrade",
        "title": "Rating-informed quality upgrade",
        "status": "proposals",
        "proposedCount": 3,
        "skippedCount": 12
      },
      {
        "id": "stale-monitoring-cleanup",
        "title": "Stale monitoring cleanup",
        "status": "proposals",
        "proposedCount": 2,
        "skippedCount": 9
      },
      {
        "id": "discovery-seed",
        "title": "Discovery seed generation",
        "status": "skipped",
        "skipReason": "disabled",
        "detail": "disabled in policy.rules.discovery-seed.enabled"
      }
    ],
    "proposals": [
      {
        "key": "stale-monitoring-cleanup:artist:233",
        "ruleId": "stale-monitoring-cleanup",
        "code": "monitored-artist-unconsumed",
        "subject": {
          "kind": "artist",
          "name": "Generic Chillhop",
          "plexId": "29104",
          "artistId": 233,
          "artistMbid": "c8da2e40-bd28-4d4e-813a-bd2f51958ba8"
        },
        "identity": { "category": "authoritative", "reason": "unique-exact-mbid" },
        "before": { "monitored": true },
        "after": { "monitored": false },
        "checks": [
          {
            "signal": "lidarrArtists",
            "label": "monitored",
            "comparator": "==",
            "bound": true,
            "observed": true,
            "satisfied": true,
            "configPath": null
          },
          {
            "signal": "plexTrackPlays",
            "label": "track coverage",
            "comparator": ">=",
            "bound": 1,
            "observed": 31,
            "satisfied": true,
            "configPath": "policy.rules.stale-monitoring-cleanup.requireTrackCoverage"
          },
          {
            "signal": "plexArtistRatings",
            "label": "artistRating",
            "comparator": ">=",
            "bound": 4,
            "observed": null,
            "satisfied": false,
            "configPath": "policy.rules.stale-monitoring-cleanup.protectRatingAtOrAbove"
          },
          {
            "signal": "lidarrArtists",
            "label": "trackFileCount",
            "comparator": ">=",
            "bound": 1,
            "observed": 22,
            "satisfied": true,
            "configPath": "policy.rules.stale-monitoring-cleanup.minTrackFileCount"
          },
          {
            "signal": "plexTrackPlays",
            "label": "plays",
            "comparator": "<=",
            "bound": 0,
            "observed": 0,
            "satisfied": true,
            "configPath": "policy.rules.stale-monitoring-cleanup.maxPlays"
          }
        ],
        "observations": {
          "plays": { "status": "observed", "value": 0, "join": "normalized-name", "sampleSize": 31 },
          "rating": { "status": "unavailable", "reason": "unrated" },
          "monitored": { "status": "observed", "value": true, "join": "exact-artist-mbid" },
          "trackFileCount": { "status": "observed", "value": 22, "join": "exact-artist-mbid" }
        },
        "summary": "0 plays and unrated in Plex while monitored in Lidarr.",
        "handoff": {
          "producer": "artist-monitoring",
          "argv": ["lidarr", "plan", "artist-monitoring", "--ids", "233", "--unmonitored"]
        }
      }
    ],
    "skips": [
      {
        "key": "stale-monitoring-cleanup:plex:31402",
        "ruleId": "stale-monitoring-cleanup",
        "code": "identity-not-authoritative",
        "subject": { "kind": "artist", "name": "Aphex Twin", "plexId": "31402", "artistMbid": null },
        "identity": { "category": "review-fuzzy-name", "reason": "unique-fuzzy-name" },
        "checks": [],
        "detail": "review-grade name evidence is never auto-consumed by a policy decision"
      }
    ],
    "coverage": {
      "plexArtistsExamined": 604,
      "plexTracksExamined": 18220,
      "authoritativeLinks": 586,
      "nonAuthoritativeArtists": 18,
      "ambiguousNameArtists": 1,
      "sentinelArtistTracks": 12,
      "unjoinedTracks": 4,
      "totalPlaysObserved": 18204
    }
  }
}
```

Failure envelope is the standard `{ command: "lidarr-policy-evaluate", error: { … } }` produced by the injected `reportLidarrFailure`, with `sensitiveValues: [cmdOptions["lidarrApiKey"], cmdOptions["plexToken"]]`.

### 10.4 CSV — flat dot-notation, `rowType`-discriminated

The shared serializer supports only two levels of nesting, so compound cells are `JSON.stringify`d.

```ts
export const LIDARR_POLICY_EVALUATE_CSV_COLUMNS = [
  "rowType", // summary | rule | proposal | skip
  "evaluatedAt",
  "status",
  "summary.proposed",
  "summary.skipped",
  "summary.rulesRun",
  "summary.rulesSkipped",
  "rule.id",
  "rule.title",
  "rule.status",
  "rule.proposedCount",
  "rule.skippedCount",
  "rule.skipReason",
  "decision.key",
  "decision.ruleId",
  "decision.code",
  "decision.subject.name",
  "decision.subject.plexId",
  "decision.subject.artistId",
  "decision.subject.artistMbid",
  "decision.identity.category",
  "decision.identity.reason",
  "decision.summary",
  "decision.detail",
  "decision.handoff.producer",
  "decision.beforeJson",
  "decision.afterJson",
  "decision.checksJson",
  "decision.observationsJson",
  "decision.handoffArgvJson",
  "coverage.plexArtistsExamined",
  "coverage.plexTracksExamined",
  "coverage.authoritativeLinks",
  "coverage.nonAuthoritativeArtists",
  "coverage.ambiguousNameArtists",
  "coverage.sentinelArtistTracks",
  "coverage.unjoinedTracks",
  "coverage.totalPlaysObserved",
] as const;
```

### 10.5 Exit semantics

Only `0` and `1`. The command sets `process.exitCode = 1`; it never calls `process.exit()`. The `--fail-on` gate is applied **after** rendering, so the operator always sees the evidence behind a failing run. Skips, coverage gaps, and degraded slots are data, not failures — except that a `degraded` report always trips any non-`none` level.

---

## 11. Command layer

`src/commands/lidarr-policy.ts` is templated on `src/commands/lidarr-reconcile.ts` (500 lines, the reference ceiling), with rendering split into `src/commands/lidarr-policy-presenter.ts` (the `lidarr-mutation-presenter.ts` precedent).

```ts
export interface LidarrPolicyCommandDeps {
  readonly resolveFormat: () => OutputFormat;
  readonly reportLidarrFailure: (
    subcommand: string,
    error: unknown,
    options: {
      readonly staleHint: boolean;
      readonly format: OutputFormat;
      readonly sensitiveValues: readonly unknown[];
    },
  ) => Promise<void>;
  readonly renderExecutionSummary: (execution: LidarrExecutionSuccessMetadata) => void;
  readonly parseIdList: (value: string, previous?: readonly string[]) => readonly string[];
  /** Test/embedding seam; production keeps the action import lazy. */
  readonly loadActions?: () => Promise<LidarrPolicyActions>;
}

export function createLidarrPolicyCommand(deps: LidarrPolicyCommandDeps): Command;
```

Contract:

- Imports **nothing** from `./lidarr.js` (ESM cycle). All parent helpers are injected.
- Statically imports only `../types/lidarr-policy.js` (zero value imports) for the `--rule` value list and `shouldFailPolicyEvaluation`.
- Validates inside `.action()`'s `try` block, **before** `await loadActions()`, so a bad `--rule` produces the standard failure envelope with no adapter, client, or DB constructed.
- Machine output → stdout via lazily imported `formatOutput`; human output → `console.error` only.
- Registered in `src/commands/lidarr.ts` at index 7 (immediately after `reconcile`):

```ts
lidarrCommand.addCommand(
  createLidarrPolicyCommand({
    resolveFormat,
    reportLidarrFailure,
    renderExecutionSummary,
    parseIdList,
  }),
);
```

Action barrel `src/actions/lidarr/index.ts`:

```ts
export { executeLidarrPolicyEvaluate, TIER as LIDARR_POLICY_EVALUATE_TIER } from "./policy-evaluate.js";
export type {
  LidarrPolicyEvaluateActionOptions,
  LidarrPolicyEvaluateActionResult,
  LidarrPolicyEvaluateDependencies,
} from "./policy-evaluate.js";
```

Action seam (`src/actions/lidarr/policy-evaluate.ts`), copying `reconcile.ts:90-126`:

```ts
export const TIER: LidarrTier = "local-only";

export interface LidarrPolicyEvaluateDependencies {
  readonly executeReconcile: typeof executeLidarrReconcile;
  readonly gatherLidarrArtists: typeof gatherLidarrArtists;
  readonly gatherLidarrQualityProfiles: typeof gatherLidarrQualityProfiles;
  readonly gatherPlexArtistRatings: typeof gatherPlexArtistRatings;
  readonly gatherPlexTrackPlays: typeof gatherPlexTrackPlays;
  readonly resolveScheduler: () => Pick<LidarrScheduler, "runSingle">;
  readonly loadedPolicyConfig: typeof getLoadedPolicyConfig;
  readonly indexAuthoritativeIdentities: typeof indexAuthoritativeIdentities;
  readonly runEvaluation: typeof runLidarrPolicyEvaluation;
  readonly now: () => Date;
}

const DEFAULT_DEPENDENCIES: LidarrPolicyEvaluateDependencies = Object.freeze({
  /* … */
});

export async function executeLidarrPolicyEvaluate(
  options: LidarrPolicyEvaluateActionOptions,
  dependencies: LidarrPolicyEvaluateDependencies = DEFAULT_DEPENDENCIES,
): Promise<LidarrPolicyEvaluateActionResult>;
```

The action returns `Object.freeze({ report, execution })`, writes no stdout, and never sets `process.exitCode`.

---

## 12. Shell completions

All three templates change in the **same commit** — `templates.spec.ts` asserts order-sensitive equality across bash, zsh, and fish simultaneously.

**`bash.ts`** — five sites: `"policy"` in `lidarr_subcommands` (:164); `local lidarr_policy_evaluate_opts="…"` (~:172); `"policy"` in the subcommand-detection `case` (:209); every value-taking flag added to the shared `case "$prev" in` list (:355); an `elif [[ "$subcmd" == "policy" ]]` routing branch (~:591) that further routes on the `evaluate` operation — copy the `presets` nested-group shape.

**`zsh.ts`** — two sites: `'policy:Evaluate consumption-driven Lidarr policies'` in the `lidarr_subcmds` describe array, immediately after `reconcile` (:415); a nested `policy)` `_arguments` block with the `evaluate` operation, ending with `${globalOpts}`.

**`fish.ts`** — three sites: `__fish_rfmedia_lidarr_policy_needs_operation` and `__fish_rfmedia_lidarr_policy_evaluate_active` predicates using the **global-option-skipping** form at `fish.ts:1243-1266` (**not** the naive `test "$cmd[3]"` form used by older leaves); the `-a "policy"` subcommand line (~:1488) and `-a "evaluate"` operation line; one `complete … -l <flag>` line per option, with `-r` on **every** value-taking flag or the global sweep at `templates.spec.ts:1369` fails.

Value-taking flags: `--plex-library`, `--rule`, `--max-proposals`, `--explain`, `--fail-on`, `--plex-url`, `--plex-token`, `--lidarr-url`, `--lidarr-api-key`. Boolean flags: `--verbose`.

Completion scripts stay 100 % static: no config read, no credential-store read, no adapter construction, no `fetch`, and no shelling back into `rfmedia lidarr policy`.

---

## 13. Docs and ROADMAP

**New:** `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`, following the `plex-lidarr-reconciliation.md` section order:

Overview → Use → Options → Signals and Their Limits → Evidence Tiers → The Three Rules (one section each, with the decision-code catalogue and per-rule threshold table) → Configuration Reference → Disputing a Decision (`--explain`, and how to tune a threshold) → Output Schemas → Exit Behavior → Safety and Follow-Up Boundaries → Troubleshooting → Related Documentation.

The doc **must** state, plainly and prominently:

1. `stale` means low absolute play count and **not** recency — the domain has no `lastViewedAt`.
2. Play counts are **per Plex account**; a service token whose account is not the listening account sees zeros. Includes the "Which Plex account do the play counts come from?" section and the `totalPlaysObserved` tell.
3. Play totals are a **normalized-name rollup**, not an id join, and collisions plus the `"Unknown Artist"` sentinel bucket fail closed.
4. Evaluation **never mutates and never writes a plan artifact**; reaching a mutation is three separate human-initiated commands.
5. A full evaluation is expensive (`plex.cache.enabled` defaults to `false`), and `--rule` is **not** a cost lever — every registered rule requires or enriches on `plexTrackPlays`, so no selection avoids the track drain. `plex.cache.enabled: true` is the only lever.
6. Plays roll up to the **album** artist (`grandparentTitle`), so compilation-only consumption reads as zero plays under the performer's own name and `requireTrackCoverage` does not catch it.
7. The rating veto `protectRatingAtOrAbove` is always active; there is no disabling value, and `null` is not one.

**Modified:** `packages/rfmedia-cli/README.md` — a per-leaf prose section in the Lidarr chapter next to `reconcile` (~line 5223), plus the Lidarr Integration feature bullet near line 18. Config options are documented here and in the feature doc because `buildConfigTemplate` feeds `yaml.dump` and cannot carry comments.

**Modified:** `ROADMAP.md` — mark #209 delivered under Sprint 1 Layer 3 with the PR link; keep #221 listed as dependent future work; add the four child issues from §15 as follow-ups.

Markdown: blank line around every heading; run `npm run format`.

---

## 14. Testing strategy

Only tests that are either (a) load-bearing for correctness/safety or (b) hard suite gates. Colocated `src/**/*.test.ts`; `vi.clearAllMocks()` in `beforeEach`, never `vi.resetAllMocks()`. Run with `env -u FORCE_COLOR`.

### 14.1 `src/lib/bridge/policy-signals.test.ts` — **CRITICAL**

_Why:_ the join is the single place a silently wrong answer would be invisible and would produce a real unmonitor proposal. Pure, zero mocks, plain frozen fixtures (the `reconcile.test.ts` style).

- Only `report.matchedExact` mints a `PolicyIdentityLink`; every other category yields an `identity-not-authoritative` skip with the right `identity.category`.
- Two Plex artists normalizing to the same name → **both** play observations are `ambiguous-name-join`.
- A track whose artist is `"Unknown Artist"` poisons that key permanently and increments `coverage.sentinelArtistTracks`.
- A track matching no bridge item increments `coverage.unjoinedTracks` and is never silently dropped.
- `rating === null` (unrated) is distinct from rating `0`; ratings join on `plexId` and are unaffected by name collisions.
- `coverage.totalPlaysObserved` sums correctly across albums.
- Indexes are frozen and deterministic.

### 14.2 `src/lib/bridge/policy-rules.test.ts` — **CRITICAL**

_Why:_ this is the decision matrix, including every safety veto on the one rule with blast radius.

- Threshold boundaries for both consumption rules (at, just below, just above).
- `stale-monitoring-cleanup` refuses when `totalPlaysObserved === 0` (per-account sanity gate) with `consumption-signal-empty`.
- `protectRatingAtOrAbove` vetoes a highly-rated zero-play artist → `rating-protected`.
- `LidarrArtist.statistics === undefined` → `signal-unavailable` (`lidarr-statistics-absent`), **never** read as `0`.
- `trackFileCount < minTrackFileCount` → `no-consumption-coverage` (never unmonitor an artist still being acquired).
- `requireTrackCoverage: true` + zero joined tracks → `no-consumption-coverage`.
- A `lidarrOnly` artist is always refused with `no-consumption-coverage`.
- Already-converged (`monitored === false`, or `qualityProfileId === target`) → `already-converged`, no proposal.
- Skip precedence: an artist blocked by two causes reports the earlier one in `POLICY_SKIP_ORDER`.
- Unrated is `signal-unavailable`, never a low rating.
- `discovery-seed` seeds only from `reason === "no-candidate"`, never from review/ambiguous/conflict `plexOnly` members.
- Every proposal carries a non-empty `checks` array, and every configured check has a populated `configPath`.
- **Invariant:** no `handoff.argv` names `"apply"` or `"--plan-file"` in a structural position; option values (`--artist "apply"`, `--quality-profile "apply"`) are exempt and pinned as such.

### 14.3 `src/lib/bridge/policy-engine.test.ts` — **CRITICAL**

_Why:_ the five structural guarantees inherited from the audit engine are exactly what a `--json` consumer relies on.

- Every registered rule appears in `report.rules` exactly once, regardless of selection.
- An unavailable **required** slot skips that rule with the slot's reason; an unavailable **enriches** slot does not gate.
- A throwing evaluator degrades the report to `rule-error` while every sibling still runs.
- Status precedence `degraded` > `proposals` > `clean`.
- Deterministic ordering and `Object.isFrozen` on the report.
- `shouldFailPolicyEvaluation` truth table, including `degraded` tripping at `proposals`.

### 14.4 `src/commands/lidarr-policy.test.ts` — **CRITICAL**

_Why:_ the command layer owns the output boundary and the exit code; a regression here is invisible to every pure test.

- Machine output to stdout, human output to stderr.
- `loadActions` is **not** called on a validation failure (the lazy-load contract).
- Exact `options.map(o => o.long)` array and `Usage: rfmedia lidarr policy evaluate [options]` help text.
- `--fail-on proposals` sets `process.exitCode = 1` **only after** rendering.
- Root `--output yaml` failure envelope with redaction.
- Set `RFMEDIA_PLEX_AUTH_DIR` to a `tmpdir()` in `beforeEach` (any test touching the Plex resolver without a token reads the developer's real credential store otherwise).

### 14.5 `src/lib/config.test.ts` — **MODIFY, CRITICAL**

_Why:_ guards the silent-drop bug class this repo has shipped three times.

New `describe("policy validation")` block mirroring `discovery.lastfm` (`config.test.ts:943-999`):

- Exact optional shape with **no defaults injected** (`validateConfig({}).policy` is `undefined`; `{policy:{}}` is `{}`).
- `it.each([[rawConfig, expectedPropertyPath]])` rejection table covering wrong types **and** unknown keys at **every** nesting level — `policy`, `policy.rules`, an **unknown rule id**, and every field of all three rules.
- Bounds loops for `validateStarRating` and every `validateBoundedInteger` ceiling.

### 14.6 Hard suite gates — **MODIFY**

- `src/commands/lidarr.test.ts:25` — `"policy"` inserted into `LIDARR_COMMAND_NAMES` after `"reconcile"`, plus a `LIDARR_POLICY_COMMAND_NAMES = ["evaluate"] as const` mirroring `LIDARR_PRESET_COMMAND_NAMES`.
- `src/lib/shell-completions/templates.spec.ts` — `"policy"` in `lidarrCommandTree.lidarr` after `"reconcile"`; `policy: ["evaluate"]`; a `lidarrPolicyEvaluateOptions` `[option, takesValue]` tuple const; the tri-shell lock test reusing `extractBashCandidates` / `extractZshCaseOptions` / `extractFishOptions` / `sorted`; the global fish `-r` sweep entry keyed on `__fish_rfmedia_lidarr_policy_evaluate_active`.

### 14.7 Deliberately NOT written

- No action-level integration test for `policy-evaluate` — its DI seam is exercised through the command test, and everything worth testing is pure and covered above.
- No `policy-gather` test: it is a mechanical clone of `probeLidarrAuditPlex`, whose behavior is already pinned.
- No plan-engine or apply tests: builders, validators, checksums, and authorization are unchanged.
- No snapshot tests, no benchmark (nothing here is on a path CI benches at scales 10/100).

### 14.8 Verification commands

```bash
node packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs
npm run build -w packages/rf-common
npm run typecheck --workspace packages/rfmedia-cli   # fires codegen:lidarr:check + check:architecture + test:architecture
env -u FORCE_COLOR npm run test:run -w packages/rfmedia-cli
npm run lint
npm run format
```

---

## 15. Follow-up child issues

| Title                                                  | Why separate                                                                                                                                                                                                    |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feat(rfmedia): add lidarr policy plan verb`           | One-step evaluate→sealed-artifact. Needs its own action, `proposal-to-plan` translation, and result union. The seam (`policy` parent + `handoff.producer`) already exists.                                      |
| `chore(rfmedia): extract config validation primitives` | Moving `ConfigError` and 7 primitives out of the 4 794-line `config.ts` touches 111 call sites and a 3 331-line test. Zero user-facing benefit; must not ride a feature PR.                                     |
| `feat(rfmedia): add policy decision override surface`  | A dispute/suppression config surface. #209 delivers explainability (`--explain` + `configPath`); overrides are a distinct feature with real design questions (key stability, staleness reporting).              |
| `feat(rfmedia): add Plex recency consumption signals`  | `lastViewedAt` / `skipCount` require a coordinated 4-7 layer change (wire type + guard + mapper + domain + optionally the filter DSL and pushdown translators). Unblocks a true "stale" rule and overlaps #210. |

---

## 16. Resolutions of the open questions (binding)

These four questions were left open by the design synthesis. They are resolved here and are
binding on implementation.

### 16.1 Missing `targetQualityProfile` degrades the rule, it does not kill the report

`rating-quality-upgrade.targetQualityProfile` is resolved live against
`client.listQualityProfiles()`. When the configured name resolves to nothing, the engine **does
not throw**. It emits a rule-level skip carrying the configured name and the available profile
names, and the report status becomes `degraded`.

**Why:** the engine's whole contract is that every refusal is individually visible and that a
failing rule never silences its siblings (§14.3). Throwing `LookupNotFoundError` would delete a
`stale-monitoring-cleanup` report because an unrelated rule was misconfigured. A rule skip is
equally loud — it prints prominently and trips `--fail-on degraded` — without collateral damage.
Config-time validation cannot check profile existence anyway, so the check has to live here.

### 16.2 `--max-proposals` stays global

One global per-rule cap override, matching `POLICY_MAX_PROPOSALS_PER_RULE`. No
`--max-proposals rule=N` syntax. Per-rule caps are speculative generality until an operator
reports a genuinely noisy single rule; the config file already allows per-rule tuning for the
persistent case.

### 16.3 Cap ranking is by evidence strength, and it is documented contract

When a cohort exceeds its cap, proposals are ranked **by evidence strength** before the cut, not
by id:

| Rule                       | Cap ranking                                                       |
| -------------------------- | ----------------------------------------------------------------- |
| `rating-quality-upgrade`   | `rating desc, lidarrId asc`                                       |
| `stale-monitoring-cleanup` | `plays asc, lidarrId asc` (least-consumed first)                  |
| `discovery-seed`           | `rating desc, plays desc, plexId asc` (already specified in §6.3) |

**Why:** a cap that cuts on `lidarrId` discards the most valuable proposals for an arbitrary
reason. `discovery-seed` already ranks by evidence, so ranking the other two the same way is the
consistent choice rather than a new concept. The report's own display order is unchanged; only the
cap cut uses this ranking. Both the ranking and the fact that it differs from display order are
stated in the feature doc and in each rule's `description`.

### 16.4 `totalPlaysObserved === 0` skips only `stale-monitoring-cleanup`

Unchanged from §6.2. The empty-consumption gate is rule-scoped.

**Why:** `stale-monitoring-cleanup` is the only rule that treats absence of plays as _evidence
for_ acting. The other two use plays exclusively to make themselves more conservative
(`minPlays` is a floor a candidate must clear), so a zero-play library makes them propose less,
never more. Degrading the whole report would suppress correct, useful output. The rule skip
already sets report status to `degraded`, so the condition remains visible at the top level.
