/**
 * Pure evidence fingerprinting and disposition for configured policy overrides.
 *
 * Rule evaluators mint stable proposal keys but do not know the report's Plex and
 * Lidarr scope. This module stamps bounded proposals once that scope is known,
 * then withholds exact and stale disputes from the sole actionable collection.
 * It owns no client, adapter, store, clock, producer, prompt, or apply capability.
 */

import { createHash } from "node:crypto";

import {
  POLICY_DECISION_CODES,
  POLICY_PRODUCER_IDS,
  POLICY_RULE_IDS,
  POLICY_SIGNALS,
} from "../../types/lidarr-policy.js";
import type { PolicyOverrideConfigOptions } from "../../types/config.js";
import type {
  PolicyDecisionEvidenceFingerprint,
  PolicyDecisionKey,
  PolicyEvaluatedProposal,
  PolicyObservation,
  PolicyOverrideResult,
  PolicyProposal,
  PolicyRuleId,
  PolicyRuleResult,
  PolicySkip,
} from "../../types/lidarr-policy.js";
import { policyArtistKey, policyPlexKey } from "./policy-rule-support.js";

/** Domain separator for the exact evidence tuple hashed by this module. */
export const POLICY_EVIDENCE_FINGERPRINT_SCHEMA = "rfmedia.lidarr-policy-evidence.v1" as const;

/** Credential-free environment scope bound into every proposal fingerprint. */
export interface PolicyDecisionEvidenceScope {
  readonly plexOrigin: string;
  readonly lidarrOrigin: string;
  readonly plexLibrary: string;
}

/** Inputs to the post-cap override reconciliation pass. */
export interface PolicyOverrideReconciliationInput extends PolicyDecisionEvidenceScope {
  readonly proposals: readonly PolicyProposal[];
  readonly skips: readonly PolicySkip[];
  readonly rules: readonly PolicyRuleResult[];
  readonly overrides: Readonly<Record<PolicyDecisionKey, PolicyOverrideConfigOptions>> | undefined;
}

/** The actionable report proposals and review evidence produced by reconciliation. */
export interface PolicyOverrideReconciliationResult {
  readonly proposals: readonly PolicyEvaluatedProposal[];
  readonly overrides: readonly PolicyOverrideResult[];
}

type PolicyScalar = string | number | boolean | null;

const POLICY_SUBJECT_KINDS = ["artist"] as const;
const POLICY_OBSERVATION_STATUSES = ["observed", "unavailable"] as const;
const POLICY_OBSERVATION_GAPS = [
  "unrated",
  "no-plex-artist",
  "ambiguous-name-join",
  "sentinel-artist-name",
  "no-track-coverage",
  "no-recency-coverage",
  "partial-recency-coverage",
  "lidarr-statistics-absent",
] as const;
const POLICY_JOIN_GRADES = ["exact-plex-id", "exact-artist-mbid", "normalized-name"] as const;
const POLICY_CHECK_SIGNALS = [...POLICY_SIGNALS, "derived"] as const;
const POLICY_CHECK_COMPARATORS = [">=", "<=", "==", "!=", "older-than-days"] as const;
const POLICY_HANDOFF_PRODUCERS = [...POLICY_PRODUCER_IDS, "discovery"] as const;
const POLICY_IDENTITY_CATEGORIES = [
  "authoritative",
  "review-normalized-name",
  "review-fuzzy-name",
  "ambiguous",
  "unmatched",
  "conflict",
  "unavailable",
] as const;
const POLICY_IDENTITY_REASONS = [
  "unique-exact-mbid",
  "unique-normalized-name",
  "unique-fuzzy-name",
  "normalized-name-collision",
  "insufficient-score",
  "insufficient-margin",
  "no-candidate",
  "missing-source-mbid",
  "malformed-source-mbid",
  "conflicting-source-mbids",
  "duplicate-source-mbid",
  "malformed-target-mbid",
  "duplicate-target-mbid",
  "contradictory-mbid",
  "missing-compatible-snapshot",
  "stale-snapshot",
  "incompatible-snapshot",
  "invalid-response",
  "no-authoritative-source-match",
] as const;

type ClosedUnionRegistryIsComplete<Domain, Registry extends readonly Domain[]> =
  Exclude<Domain, Registry[number]> extends never ? true : never;

const _policyFingerprintClosedUnionsAreComplete: {
  readonly subjectKinds: ClosedUnionRegistryIsComplete<
    PolicyProposal["subject"]["kind"],
    typeof POLICY_SUBJECT_KINDS
  >;
  readonly observationStatuses: ClosedUnionRegistryIsComplete<
    PolicyObservation<number | boolean>["status"],
    typeof POLICY_OBSERVATION_STATUSES
  >;
  readonly observationGaps: ClosedUnionRegistryIsComplete<
    Extract<PolicyObservation<number | boolean>, { readonly status: "unavailable" }>["reason"],
    typeof POLICY_OBSERVATION_GAPS
  >;
  readonly joinGrades: ClosedUnionRegistryIsComplete<
    Extract<PolicyObservation<number | boolean>, { readonly status: "observed" }>["join"],
    typeof POLICY_JOIN_GRADES
  >;
  readonly checkSignals: ClosedUnionRegistryIsComplete<
    PolicyProposal["checks"][number]["signal"],
    typeof POLICY_CHECK_SIGNALS
  >;
  readonly checkComparators: ClosedUnionRegistryIsComplete<
    PolicyProposal["checks"][number]["comparator"],
    typeof POLICY_CHECK_COMPARATORS
  >;
  readonly handoffProducers: ClosedUnionRegistryIsComplete<
    PolicyProposal["handoff"]["producer"],
    typeof POLICY_HANDOFF_PRODUCERS
  >;
  readonly identityCategories: ClosedUnionRegistryIsComplete<
    PolicyProposal["identity"]["category"],
    typeof POLICY_IDENTITY_CATEGORIES
  >;
  readonly identityReasons: ClosedUnionRegistryIsComplete<
    PolicyProposal["identity"]["reason"],
    typeof POLICY_IDENTITY_REASONS
  >;
} = {
  subjectKinds: true,
  observationStatuses: true,
  observationGaps: true,
  joinGrades: true,
  checkSignals: true,
  checkComparators: true,
  handoffProducers: true,
  identityCategories: true,
  identityReasons: true,
};
void _policyFingerprintClosedUnionsAreComplete;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`Cannot fingerprint policy proposal: ${path} must be a string`);
  }
  return value;
}

function requireEnum(value: unknown, allowed: readonly string[], path: string): string {
  const canonical = requireString(value, path);
  if (!allowed.includes(canonical)) {
    throw new TypeError(
      `Cannot fingerprint policy proposal: ${path} must be one of ${allowed.join(", ")}`,
    );
  }
  return canonical;
}

function requireScalar(value: PolicyScalar, path: string): PolicyScalar {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new TypeError(`Cannot fingerprint policy proposal: ${path} is not a finite JSON scalar`);
}

function sortedState(
  state: Readonly<Record<string, PolicyScalar>>,
  path: "before" | "after",
): readonly (readonly [string, PolicyScalar])[] {
  return Object.keys(state)
    .sort(compareCodeUnits)
    .map((key) => [key, requireScalar(state[key] as PolicyScalar, `${path}.${key}`)] as const);
}

function projectObservation(
  signal: string,
  observation: PolicyObservation<number | boolean>,
): readonly unknown[] {
  requireEnum(observation.status, POLICY_OBSERVATION_STATUSES, `observations.${signal}.status`);
  if (observation.status === "unavailable") {
    return [
      signal,
      "unavailable",
      requireEnum(observation.reason, POLICY_OBSERVATION_GAPS, `observations.${signal}.reason`),
      null,
      null,
    ];
  }
  return [
    signal,
    "observed",
    requireScalar(observation.value, `observations.${signal}.value`),
    requireEnum(observation.join, POLICY_JOIN_GRADES, `observations.${signal}.join`),
    observation.sampleSize === undefined
      ? null
      : requireScalar(observation.sampleSize, `observations.${signal}.sampleSize`),
  ];
}

function fingerprintMaterial(
  proposal: PolicyProposal,
  scope: PolicyDecisionEvidenceScope,
): readonly unknown[] {
  return [
    POLICY_EVIDENCE_FINGERPRINT_SCHEMA,
    [
      "scope",
      requireString(scope.plexOrigin, "scope.plexOrigin"),
      requireString(scope.lidarrOrigin, "scope.lidarrOrigin"),
      requireString(scope.plexLibrary, "scope.plexLibrary"),
    ],
    [
      "decision",
      requireString(proposal.key, "key"),
      requireEnum(proposal.ruleId, POLICY_RULE_IDS, "ruleId"),
      requireEnum(proposal.code, POLICY_DECISION_CODES, "code"),
    ],
    [
      "subject",
      requireEnum(proposal.subject.kind, POLICY_SUBJECT_KINDS, "subject.kind"),
      requireString(proposal.subject.plexId, "subject.plexId"),
      proposal.subject.artistId === undefined
        ? null
        : requireScalar(proposal.subject.artistId, "subject.artistId"),
      proposal.subject.artistMbid === null
        ? null
        : requireString(proposal.subject.artistMbid, "subject.artistMbid"),
    ],
    [
      "identity",
      requireEnum(proposal.identity.category, POLICY_IDENTITY_CATEGORIES, "identity.category"),
      requireEnum(proposal.identity.reason, POLICY_IDENTITY_REASONS, "identity.reason"),
    ],
    ["before", sortedState(proposal.before, "before")],
    ["after", sortedState(proposal.after, "after")],
    [
      "checks",
      proposal.checks.map((check, index) => [
        requireEnum(check.signal, POLICY_CHECK_SIGNALS, `checks.${index}.signal`),
        requireEnum(check.comparator, POLICY_CHECK_COMPARATORS, `checks.${index}.comparator`),
        requireScalar(check.bound, `checks.${index}.bound`),
        requireScalar(check.observed, `checks.${index}.observed`),
        requireScalar(check.satisfied, `checks.${index}.satisfied`),
        check.configPath === null
          ? null
          : requireString(check.configPath, `checks.${index}.configPath`),
      ]),
    ],
    [
      "observations",
      Object.keys(proposal.observations)
        .sort(compareCodeUnits)
        .map((signal) => {
          const observation = proposal.observations[signal];
          if (observation === undefined) {
            throw new TypeError(
              `Cannot fingerprint policy proposal: observations.${signal} is undefined`,
            );
          }
          return projectObservation(signal, observation);
        }),
    ],
    [
      "handoff",
      requireEnum(proposal.handoff.producer, POLICY_HANDOFF_PRODUCERS, "handoff.producer"),
    ],
  ];
}

/** Returns the deterministic, scope-bound SHA-256 fingerprint for one proposal. */
export function fingerprintPolicyProposal(
  proposal: PolicyProposal,
  scope: PolicyDecisionEvidenceScope,
): PolicyDecisionEvidenceFingerprint {
  const material = JSON.stringify(fingerprintMaterial(proposal, scope));
  const digest = createHash("sha256").update(material, "utf8").digest("hex");
  return `sha256:${digest}`;
}

function stampProposal(
  proposal: PolicyProposal,
  scope: PolicyDecisionEvidenceScope,
): PolicyEvaluatedProposal {
  return Object.freeze({
    ...proposal,
    evidenceFingerprint: fingerprintPolicyProposal(proposal, scope),
  });
}

function proposalAnchor(decision: PolicyProposal | PolicySkip): PolicyDecisionKey {
  return decision.subject.artistId === undefined
    ? policyPlexKey(decision.ruleId, decision.subject.plexId)
    : policyArtistKey(decision.ruleId, decision.subject.artistId);
}

function ruleIdFromOverrideKey(key: PolicyDecisionKey): PolicyRuleId {
  const ruleId = POLICY_RULE_IDS.find((candidate) => key.startsWith(`${candidate}:`));
  if (ruleId === undefined) {
    throw new TypeError(`Configured policy override has no registered rule prefix: ${key}`);
  }
  return ruleId;
}

function overrideResult(input: {
  readonly key: PolicyDecisionKey;
  readonly configured: PolicyOverrideConfigOptions;
  readonly status: PolicyOverrideResult["status"];
  readonly staleReason: PolicyOverrideResult["staleReason"];
  readonly currentEvidenceFingerprint: PolicyDecisionEvidenceFingerprint | null;
  readonly decision: PolicyEvaluatedProposal | PolicySkip | null;
}): PolicyOverrideResult {
  return Object.freeze({
    key: input.key,
    action: input.configured.action,
    status: input.status,
    staleReason: input.staleReason,
    reason: input.configured.reason,
    expectedEvidenceFingerprint: input.configured.evidenceFingerprint,
    currentEvidenceFingerprint: input.currentEvidenceFingerprint,
    decision: input.decision,
  });
}

/**
 * Stamps bounded proposals, classifies every configured override, and withholds
 * exact or stale proposal matches without refilling the already-cut cohort.
 */
export function reconcilePolicyOverrides(
  input: PolicyOverrideReconciliationInput,
): PolicyOverrideReconciliationResult {
  const scope: PolicyDecisionEvidenceScope = {
    plexOrigin: input.plexOrigin,
    lidarrOrigin: input.lidarrOrigin,
    plexLibrary: input.plexLibrary,
  };
  const proposals = input.proposals.map((proposal) => stampProposal(proposal, scope));
  const proposalsByKey = new Map<PolicyDecisionKey, PolicyEvaluatedProposal>();
  for (const proposal of proposals) {
    if (proposalsByKey.has(proposal.key)) {
      throw new TypeError(
        `Policy proposal key is duplicated during override matching: ${proposal.key}`,
      );
    }
    proposalsByKey.set(proposal.key, proposal);
  }

  const skipsByAnchor = new Map<PolicyDecisionKey, PolicySkip>();
  const universalRefusalsByAnchor = new Map<PolicyDecisionKey, PolicySkip>();
  for (const skip of [...input.skips].sort((left, right) =>
    compareCodeUnits(left.key, right.key),
  )) {
    const anchor = proposalAnchor(skip);
    if (!skipsByAnchor.has(anchor)) {
      skipsByAnchor.set(anchor, skip);
    }
    if (skip.code === "identity-not-authoritative") {
      for (const ruleId of POLICY_RULE_IDS) {
        const universalAnchor =
          skip.subject.artistId === undefined
            ? policyPlexKey(ruleId, skip.subject.plexId)
            : policyArtistKey(ruleId, skip.subject.artistId);
        if (!universalRefusalsByAnchor.has(universalAnchor)) {
          universalRefusalsByAnchor.set(universalAnchor, skip);
        }
      }
    }
  }
  const rulesById = new Map(input.rules.map((rule) => [rule.id, rule] as const));

  const withheld = new Set<PolicyDecisionKey>();
  const results: PolicyOverrideResult[] = [];
  for (const key of Object.keys(input.overrides ?? {}).sort(compareCodeUnits)) {
    const configured = input.overrides?.[key];
    if (configured === undefined) {
      throw new TypeError(`Configured policy override is undefined: ${key}`);
    }
    const proposal = proposalsByKey.get(key);
    if (proposal !== undefined) {
      withheld.add(key);
      const exact = proposal.evidenceFingerprint === configured.evidenceFingerprint;
      results.push(
        overrideResult({
          key,
          configured,
          status: exact ? "suppressed" : "stale",
          staleReason: exact ? null : "evidence-changed",
          currentEvidenceFingerprint: proposal.evidenceFingerprint,
          decision: proposal,
        }),
      );
      continue;
    }

    const rule = rulesById.get(ruleIdFromOverrideKey(key));
    if (rule === undefined) {
      throw new TypeError(`Policy evaluation omitted the configured override rule: ${key}`);
    }
    if (rule.status === "skipped") {
      results.push(
        overrideResult({
          key,
          configured,
          status: "not-evaluated",
          staleReason: null,
          currentEvidenceFingerprint: null,
          decision: null,
        }),
      );
      continue;
    }

    const skip = skipsByAnchor.get(key) ?? universalRefusalsByAnchor.get(key);
    results.push(
      skip === undefined
        ? overrideResult({
            key,
            configured,
            status: "stale",
            staleReason: "decision-absent",
            currentEvidenceFingerprint: null,
            decision: null,
          })
        : overrideResult({
            key,
            configured,
            status: "stale",
            staleReason: "outcome-changed",
            currentEvidenceFingerprint: null,
            decision: skip,
          }),
    );
  }

  return Object.freeze({
    proposals: Object.freeze(proposals.filter((proposal) => !withheld.has(proposal.key))),
    overrides: Object.freeze(results),
  });
}
