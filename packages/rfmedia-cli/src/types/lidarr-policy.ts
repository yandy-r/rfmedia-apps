/**
 * The `rfmedia lidarr policy` contract (issue #209).
 *
 * ZERO VALUE IMPORTS. Every `import` in this module carries the `type` keyword
 * and is erased at compile time; nothing here may import a value from
 * `../lib/**`, `../actions/**`, or any sibling type module. Multiple type-only
 * import lines are fine — the discipline is *no value imports*, not *one import
 * line* (`./lidarr-audit.js` carries five and satisfies the same rule).
 *
 * Why it is a hard rule: `src/commands/lidarr-policy.ts` statically imports this
 * module for the `--rule` value list ({@link POLICY_RULE_IDS}), the declared
 * option-long list ({@link LIDARR_POLICY_EVALUATE_OPTION_LONGS}), and the exit
 * gate ({@link shouldFailPolicyEvaluation}). A single value import here would
 * drag the evaluator graph — and through it the adapters, the Lidarr client, and
 * the tracking database — into every cold start of the CLI.
 *
 * The registry (`requires` / `enriches` on {@link POLICY_RULE_DESCRIPTORS}) is
 * the single source of truth for both what the action gathers and whether a rule
 * can run. Note that every registered rule either requires or enriches on
 * `plexTrackPlays`, so `--rule` narrows *evaluation*, never the track drain;
 * `plex.cache.enabled: true` is the only lever on that cost.
 */

import type {
  PlexLidarrReconciliationResultV1,
  ReconciliationCategory,
  ReconciliationReason,
  ReconciliationSourceUnmatchedItem,
} from "./bridge.js";
import type { LidarrArtist, LidarrProfile } from "./lidarr.js";
import type { MediaArtist, MediaTrack } from "./media-server.js";

/* ── Versions ────────────────────────────────────────────────────────────── */

export const POLICY_EVALUATION_SCHEMA = "rfmedia.lidarr-consumption-policy.v3" as const;
export const POLICY_ENGINE_VERSION = 3 as const;

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

/** Why a gathered slot is absent. */
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
  | "no-recency-coverage"
  | "partial-recency-coverage"
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

export const POLICY_RULE_IDS = [
  "rating-quality-upgrade",
  "stale-monitoring-cleanup",
  "discovery-seed",
] as const;
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
    description:
      "Highly rated Plex artists whose Lidarr quality profile is not the configured target",
    requires: ["bridgeIdentity", "lidarrArtists", "lidarrQualityProfiles", "plexArtistRatings"],
    enriches: ["plexTrackPlays"],
    producer: "artist-profile-assignment",
    decisionCodes: ["rating-below-target-profile"],
  },
  "stale-monitoring-cleanup": {
    id: "stale-monitoring-cleanup",
    title: "Stale monitoring cleanup",
    description:
      "Monitored Lidarr artists with low lifetime Plex plays and, when configured, no recent consumption",
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
  readonly comparator: ">=" | "<=" | "==" | "!=" | "older-than-days";
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
 * Format: `<ruleId>:artist:<lidarrId>` or `<ruleId>:plex:<plexId>`. Deliberately
 * not a content hash: a threshold edit must not silently invalidate the key an
 * operator just read out of a report.
 */
export type PolicyDecisionKey = string;

/** Scope-bound, rotating evidence identity for one stable proposal key. */
export type PolicyDecisionEvidenceFingerprint = `sha256:${string}`;

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

/** Report-grade proposal with its copy-grade evidence fingerprint. */
export interface PolicyEvaluatedProposal extends PolicyProposal {
  readonly evidenceFingerprint: PolicyDecisionEvidenceFingerprint;
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

/** Lifecycle state of one configured policy override in the current evaluation. */
export type PolicyOverrideStatus = "suppressed" | "stale" | "not-evaluated";

/** Why a previously reviewed override no longer matches its original proposal. */
export type PolicyOverrideStaleReason = "evidence-changed" | "outcome-changed" | "decision-absent";

/** Review evidence and disposition for one configured policy override. */
export interface PolicyOverrideResult {
  readonly key: PolicyDecisionKey;
  readonly action: "suppress";
  readonly status: PolicyOverrideStatus;
  readonly staleReason: PolicyOverrideStaleReason | null;
  readonly reason: string;
  readonly expectedEvidenceFingerprint: PolicyDecisionEvidenceFingerprint;
  readonly currentEvidenceFingerprint: PolicyDecisionEvidenceFingerprint | null;
  readonly decision: PolicyEvaluatedProposal | PolicySkip | null;
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
  /** Whole-day recency floor, or null for legacy absolute-play-only behavior. */
  readonly minDaysSinceLastViewed: number | null;
  /**
   * Star rating at or above which an artist is never unmonitored.
   *
   * The veto is always active — there is no disabling value. The config schema
   * accepts `1.0`-`5.0` only, and the resolver defaults it to `4`, so `5` is the
   * narrowest setting (protects five-star artists alone).
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
  /** Actionable proposals remaining after override classification. */
  readonly proposed: number;
  readonly skipped: number;
  /** Exact key-and-evidence matches withheld from the actionable cohort. */
  readonly suppressed: number;
  /** Configured overrides quarantined because their reviewed evidence is stale. */
  readonly staleOverrides: number;
  /** Configured overrides whose rules did not run and therefore could not be assessed. */
  readonly notEvaluatedOverrides: number;
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
  /** Fingerprinted proposals that remain actionable after override classification. */
  readonly proposals: readonly PolicyEvaluatedProposal[];
  readonly skips: readonly PolicySkip[];
  /** Every configured override, including withheld and not-evaluated records. */
  readonly overrides: readonly PolicyOverrideResult[];
  readonly coverage: PolicyEvaluationCoverage;
}

/* ── Bounds ──────────────────────────────────────────────────────────────── */

export const POLICY_MAX_PROPOSALS_PER_RULE = 100;
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
 * trips at any non-`none` level; otherwise at least one actionable proposal or
 * stale override requiring review must exist. Active suppressions alone do not
 * trip the gate.
 *
 * @param report - A completed evaluation report.
 * @param failOn - The configured gate level.
 * @returns True when the command must set `process.exitCode = 1`.
 */
export function shouldFailPolicyEvaluation(
  report: PolicyEvaluationReport,
  failOn: PolicyFailOn,
): boolean {
  if (failOn === "none") {
    return false;
  }
  if (report.status === "degraded") {
    return true;
  }
  return report.summary.proposed > 0 || report.summary.staleOverrides > 0;
}

/**
 * Narrowing guard for `--rule` parsing inside the action handler.
 *
 * @param value - A raw `--rule` token.
 * @returns True when the token names a registered rule.
 */
export function isPolicyRuleId(value: string): value is PolicyRuleId {
  return (POLICY_RULE_IDS as readonly string[]).includes(value);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Everything below extends the design's §4 type surface. Each addition closes a
 * gap §4 left open that would otherwise force two independently implemented
 * modules to invent divergent shapes for the same value.
 * ──────────────────────────────────────────────────────────────────────────── */

/* ── Evaluator return channel (design §6.2, §16.1) ───────────────────────── */

/**
 * What one evaluator actually returns.
 *
 * §4's {@link PolicyRuleVerdict} has no rule-level skip channel, yet §6.2
 * requires `stale-monitoring-cleanup` to refuse wholesale with
 * `consumption-signal-empty` when `coverage.totalPlaysObserved === 0`, and §16.1
 * requires `rating-quality-upgrade` to refuse wholesale — never throw — when
 * `targetQualityProfile` resolves to no live Lidarr profile. Both are rule-level
 * outcomes with no per-subject decision behind them, so they cannot be expressed
 * as a {@link PolicySkip}. The engine turns the `ruleSkip` arm into a
 * `PolicyRuleResult` with `status: "skipped"` and degrades the report.
 */
export type PolicyRuleOutcome =
  | PolicyRuleVerdict
  | {
      readonly ruleSkip: {
        readonly reason: PolicyRuleSkipReason;
        readonly detail: string;
      };
    };

/* ── Gathered signal bundle (design §8.1) ────────────────────────────────── */

/**
 * Everything the action gathered, one slot per {@link PolicySignal}.
 *
 * The action layer produces this and the pure lib layer consumes it; the lib
 * layer never performs I/O and never resolves a client or adapter. It lives in
 * the contract rather than in either module because the gatherers and the
 * signal-join layer are built independently against it. Role analogue:
 * `LidarrAuditGatheredData` in `./lidarr-audit.js`.
 *
 * A signal absent from `requiredSignalsFor(selected)` and from
 * `enrichedSignalsFor(selected)` is never gathered and arrives as an
 * `unavailable` slot with reason `not-requested` (§8.1 item 7).
 */
export interface PolicySignalBundle {
  /** The shipped Plex↔Lidarr reconciliation report; the identity substrate. */
  readonly bridgeIdentity: PolicySignalSlot<PlexLidarrReconciliationResultV1>;
  /** Library-wide Lidarr artist list. */
  readonly lidarrArtists: PolicySignalSlot<readonly LidarrArtist[]>;
  /** Live Lidarr quality profiles, used to resolve `targetQualityProfile`. */
  readonly lidarrQualityProfiles: PolicySignalSlot<readonly LidarrProfile[]>;
  /** Plex artists carrying the normalized rating; joined on `plexId`. */
  readonly plexArtistRatings: PolicySignalSlot<readonly MediaArtist[]>;
  /** Plex tracks carrying play and optional recency evidence; weak-joined by artist name. */
  readonly plexTrackPlays: PolicySignalSlot<readonly MediaTrack[]>;
}

/* ── Join indexes and evaluator input (design §6, §8.2, §8.3, §8.6) ──────── */

/**
 * One subject the bridge could not prove authoritatively.
 *
 * Carries NO `ruleId` by design: §6.0's universal `identity-not-authoritative`
 * refusal is computed once over the whole report, and the engine attributes each
 * one to exactly one rule when it materialises the {@link PolicySkip}. Embedding
 * a `ruleId` here would either duplicate every refusal per running rule or force
 * the join layer to know the selection.
 */
export interface PolicyNonAuthoritativeSubject {
  readonly subject: PolicySubject;
  readonly identity: PolicyIdentityBasis;
  readonly detail: string;
}

/**
 * A Plex-only artist eligible to be offered as a discovery seed.
 *
 * Narrowed to `reason: "no-candidate"` at the type level (§6.3): the rest of
 * `ReconciliationPlexOnlyItem` is review/ambiguous/conflict/unavailable
 * evidence, all of which probably already exists in Lidarr under a slightly
 * different name. `no-candidate` is the only honest "absent from Lidarr" signal.
 */
export type PolicySeedCandidate = ReconciliationSourceUnmatchedItem & {
  readonly reason: "no-candidate";
};

/** The authoritative-identity index, plus every subject it had to refuse. */
export interface PolicyIdentityIndex {
  /** Every authoritative link, in deterministic order. */
  readonly links: readonly PolicyIdentityLink[];
  readonly byLidarrId: ReadonlyMap<number, PolicyIdentityLink>;
  readonly byPlexId: ReadonlyMap<string, PolicyIdentityLink>;
  /** Non-authoritative subjects, computed once (§6.0). */
  readonly nonAuthoritative: readonly PolicyNonAuthoritativeSubject[];
  /** `plexOnly` members filtered to `reason === "no-candidate"` (§6.3). */
  readonly seedCandidates: readonly PolicySeedCandidate[];
}

/**
 * The rating index — an EXACT id join.
 *
 * `MediaArtist.id` and `ReconciliationSourceIdentity.plexId` are the same
 * `ratingKey` namespace, so this join is unaffected by name collisions (§8.2).
 */
export interface PolicyRatingIndex {
  readonly byPlexId: ReadonlyMap<string, MediaArtist>;
}

/** Play and recency evidence collected from one normalized-name track bucket. */
export interface PolicyTrackSignalBucket {
  readonly plays: number;
  readonly sampleSize: number;
  readonly latestLastViewedAt: number | null;
  readonly lastViewedAtSampleSize: number;
  readonly playedRowsMissingLastViewedAt: number;
}

/**
 * The play-and-recency index — the WEAK join.
 *
 * `MediaTrack` carries `artist: string` with no id, so totals are bucketed under
 * `normalizeBridgeArtistName(track.artist)`. `poisoned` holds every normalized
 * key that must never yield a track observation: keys claimed by two or more
 * distinct Plex artists, and the `"Unknown Artist"` mapper sentinel bucket
 * (§8.2). Poisoning is fail-closed — a poisoned key blocks a proposal, it does
 * not silently report zero plays.
 */
export interface PolicyPlayIndex {
  readonly byNormalizedName: ReadonlyMap<string, PolicyTrackSignalBucket>;
  readonly poisoned: ReadonlySet<string>;
}

/**
 * Everything one evaluator receives. Pure data; no I/O handle reaches a rule.
 *
 * `selected` is the run's full selection, not the evaluator's own id, so a rule
 * can tell whether a sibling actually ran.
 */
export interface PolicyEvaluationInput {
  /** The action's single captured evaluation instant; rules never read a wall clock. */
  readonly evaluatedAt: string;
  readonly signals: PolicySignalBundle;
  readonly policy: PolicyResolvedPolicy;
  readonly coverage: PolicyEvaluationCoverage;
  readonly identity: PolicyIdentityIndex;
  readonly ratings: PolicyRatingIndex;
  readonly plays: PolicyPlayIndex;
  readonly selected: ReadonlySet<PolicyRuleId>;
}

/**
 * A rule's verdict function: pure, synchronous, indexes in / decisions out.
 *
 * Hosted in the contract rather than in the engine so the rules module and the
 * engine's private evaluator map compile against one definition. Role analogue:
 * `LidarrAuditEvaluator` in `./lidarr-audit.js`.
 */
export type PolicyRuleEvaluator = (input: PolicyEvaluationInput) => PolicyRuleOutcome;

/* ── Signal derivation (design §8.1 item 7) ──────────────────────────────── */

/**
 * Collects signals off the registry in {@link POLICY_SIGNALS} declaration order.
 *
 * Filtering the declaration-ordered tuple gives determinism and de-duplication
 * in one step, independent of the order rules were selected in.
 */
function collectPolicySignals(
  selected: readonly PolicyRuleId[],
  pick: (descriptor: PolicyRuleDescriptor) => readonly PolicySignal[],
): readonly PolicySignal[] {
  const wanted = new Set<PolicySignal>();
  for (const ruleId of selected) {
    for (const signal of pick(POLICY_RULE_DESCRIPTORS[ruleId])) {
      wanted.add(signal);
    }
  }
  return POLICY_SIGNALS.filter((signal) => wanted.has(signal));
}

/**
 * Every signal that MUST be available for the selected rules to run.
 *
 * The gatherer drives its work off this union with {@link enrichedSignalsFor},
 * so a signal absent from BOTH lists for every selected rule costs nothing.
 * `plexTrackPlays` is not such a signal: every registered rule requires or
 * enriches on it, so no `--rule` selection avoids the track drain. An
 * unavailable required slot skips its rule rather than degrading the whole
 * report (§8.7).
 *
 * @param selected - The rule ids the operator selected.
 * @returns The required signals, deduplicated, in declaration order.
 */
export function requiredSignalsFor(selected: readonly PolicyRuleId[]): readonly PolicySignal[] {
  return collectPolicySignals(selected, (descriptor) => descriptor.requires);
}

/**
 * Every signal that adds depth for the selected rules but never gates them.
 *
 * Gathered when possible; an unavailable enriching slot is reported and the
 * rule still runs (§8.7).
 *
 * @param selected - The rule ids the operator selected.
 * @returns The enriching signals, deduplicated, in declaration order.
 */
export function enrichedSignalsFor(selected: readonly PolicyRuleId[]): readonly PolicySignal[] {
  return collectPolicySignals(selected, (descriptor) => descriptor.enriches);
}

/* ── CLI option surface (design §10.1) ───────────────────────────────────── */

/**
 * Every long option `rfmedia lidarr policy evaluate` declares, in Commander
 * declaration order.
 *
 * This is the single artifact binding the leaf's declared options to the
 * generated shell-completion templates: the completion spec never constructs
 * the Commander program, so nothing else in the repo reconciles the two.
 *
 * Root `--output` and `--json` are declared on the root program and reconciled
 * by the `cli.ts` `preAction` hook; the leaf must not redeclare them, so they
 * deliberately do not appear here.
 */
export const LIDARR_POLICY_EVALUATE_OPTION_LONGS = [
  "--plex-library",
  "--rule",
  "--max-proposals",
  "--explain",
  "--fail-on",
  "--verbose",
  "--plex-url",
  "--plex-token",
  "--lidarr-url",
  "--lidarr-api-key",
] as const;
