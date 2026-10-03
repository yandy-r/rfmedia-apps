/**
 * Pure proposal projection for `rfmedia lidarr policy plan` (issue #311).
 *
 * The projector performs no I/O and never interprets the inert handoff argv.
 * Every proposal is validated before a projection is returned, then appears
 * exactly once as either a cohort change or an explicit refusal.
 */

import { LIDARR_PLAN_MAX_BATCH } from "../../types/lidarr-plan.js";
import { POLICY_PRODUCER_IDS, POLICY_RULE_DESCRIPTORS } from "../../types/lidarr-policy.js";
import type {
  PolicyDecisionKey,
  PolicyEvaluationReport,
  PolicyHandoff,
  PolicyProducerId,
  PolicyProposal,
  PolicyRuleDescriptor,
} from "../../types/lidarr-policy.js";
import { POLICY_PLAN_REFUSAL_CODES } from "../../types/lidarr-policy-plan.js";
import type {
  PolicyPlanChange,
  PolicyPlanCohort,
  PolicyPlanRefusal,
  PolicyPlanSummary,
} from "../../types/lidarr-policy-plan.js";

/** A malformed evaluator proposal violated the policy-plan bridge contract. */
export class PolicyPlanProjectionError extends Error {
  /** The offending proposal key, or `projection` for a whole-result invariant. */
  readonly decisionKey: string;

  constructor(decisionKey: string, detail: string) {
    super(`${decisionKey}: ${detail}`);
    this.name = "PolicyPlanProjectionError";
    this.decisionKey = decisionKey;
  }
}

/** The complete, artifact-free result of projecting one evaluation report. */
export interface PolicyPlanProjection {
  readonly cohorts: readonly PolicyPlanCohort[];
  readonly refusals: readonly PolicyPlanRefusal[];
  readonly summary: PolicyPlanSummary;
}

type SupportedProducer = PolicyProducerId;
type DesiredScalar = number | boolean;
type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

interface Candidate {
  readonly proposal: PolicyProposal;
  readonly producer: SupportedProducer;
  readonly artistId: number;
  readonly desired: DesiredScalar;
  readonly intentKey: string;
}

interface CohortDraft {
  readonly producer: SupportedProducer;
  readonly desired: DesiredScalar;
  readonly candidates: Candidate[];
}

const PRODUCER_ORDER: ReadonlyMap<PolicyProducerId, number> = new Map(
  POLICY_PRODUCER_IDS.map((producer, index) => [producer, index] as const),
);

const REFUSAL_ORDER: ReadonlyMap<PolicyPlanRefusal["code"], number> = new Map(
  POLICY_PLAN_REFUSAL_CODES.map((code, index) => [code, index] as const),
);

function describe(value: unknown): string {
  return value === undefined ? "absent" : JSON.stringify(value);
}

function requireDescriptor(proposal: PolicyProposal): PolicyRuleDescriptor {
  const descriptors: Readonly<Record<string, PolicyRuleDescriptor | undefined>> =
    POLICY_RULE_DESCRIPTORS;
  const descriptor = descriptors[proposal.ruleId];
  if (descriptor === undefined) {
    throw new PolicyPlanProjectionError(
      proposal.key,
      `ruleId ${JSON.stringify(proposal.ruleId)} has no registered policy descriptor`,
    );
  }
  if (!descriptor.decisionCodes.includes(proposal.code)) {
    throw new PolicyPlanProjectionError(
      proposal.key,
      `decision code ${JSON.stringify(proposal.code)} is not declared by rule ${descriptor.id}`,
    );
  }
  return descriptor;
}

function expectedProducer(descriptor: PolicyRuleDescriptor): PolicyHandoff["producer"] {
  return descriptor.producer ?? "discovery";
}

function validateHandoff(
  proposal: PolicyProposal,
  descriptor: PolicyRuleDescriptor,
): PolicyHandoff["producer"] {
  const expected = expectedProducer(descriptor);
  if (proposal.handoff.producer !== expected) {
    throw new PolicyPlanProjectionError(
      proposal.key,
      `handoff producer ${JSON.stringify(proposal.handoff.producer)} disagrees with rule ${descriptor.id}, which declares ${JSON.stringify(expected)}`,
    );
  }
  return proposal.handoff.producer;
}

function requireAuthoritativeArtistId(proposal: PolicyProposal): number {
  if (
    proposal.identity.category !== "authoritative" ||
    proposal.identity.reason !== "unique-exact-mbid"
  ) {
    throw new PolicyPlanProjectionError(
      proposal.key,
      "mutation-bound proposal does not carry an authoritative unique-exact-mbid identity",
    );
  }
  if (proposal.subject.kind !== "artist") {
    throw new PolicyPlanProjectionError(
      proposal.key,
      `subject.kind is ${JSON.stringify(proposal.subject.kind)} rather than "artist"`,
    );
  }
  const artistId = proposal.subject.artistId;
  if (!Number.isSafeInteger(artistId) || artistId === undefined || artistId <= 0) {
    throw new PolicyPlanProjectionError(
      proposal.key,
      `subject.artistId is ${describe(artistId)} rather than a positive safe integer`,
    );
  }
  return artistId;
}

function requireProfileTarget(proposal: PolicyProposal): number {
  const target = proposal.after["qualityProfileId"];
  if (typeof target !== "number" || !Number.isSafeInteger(target) || target <= 0) {
    throw new PolicyPlanProjectionError(
      proposal.key,
      `after["qualityProfileId"] is ${describe(target)} rather than a positive safe integer`,
    );
  }
  return target;
}

function requireMonitoringTarget(proposal: PolicyProposal): boolean {
  const target = proposal.after["monitored"];
  if (typeof target !== "boolean") {
    throw new PolicyPlanProjectionError(
      proposal.key,
      `after["monitored"] is ${describe(target)} rather than a boolean`,
    );
  }
  return target;
}

function unsupportedRefusal(proposal: PolicyProposal): PolicyPlanRefusal {
  return Object.freeze({
    code: "unsupported-producer",
    decisionKey: proposal.key,
    producer: "discovery",
    artistId: null,
    detail: 'producer "discovery" has no Lidarr mutation-plan producer',
    remedy: "narrow --rule to a supported policy rule",
  });
}

function conflictRefusal(candidate: Candidate): PolicyPlanRefusal {
  return Object.freeze({
    code: "conflicting-intent",
    decisionKey: candidate.proposal.key,
    producer: candidate.producer,
    artistId: candidate.artistId,
    detail: `artist ${candidate.artistId} has incompatible policy-plan intents, so every proposal for that artist is withheld`,
    remedy: "narrow --rule so the artist has one producer and desired target",
  });
}

function freezeChange(candidate: Candidate): PolicyPlanChange {
  const proposal = candidate.proposal;
  const checks = proposal.checks.map((check) => Object.freeze({ ...check }));
  return Object.freeze({
    decisionKey: proposal.key,
    ruleId: proposal.ruleId,
    artistId: candidate.artistId,
    artistName: proposal.subject.name,
    before: Object.freeze({ ...proposal.before }),
    after: Object.freeze({ ...proposal.after }),
    checks: Object.freeze(checks),
    summary: proposal.summary,
  });
}

function compareCandidates(left: Candidate, right: Candidate): number {
  const byArtist = left.artistId - right.artistId;
  return byArtist !== 0 ? byArtist : left.proposal.key.localeCompare(right.proposal.key);
}

function compareDrafts(left: CohortDraft, right: CohortDraft): number {
  const byProducer =
    (PRODUCER_ORDER.get(left.producer) ?? Number.MAX_SAFE_INTEGER) -
    (PRODUCER_ORDER.get(right.producer) ?? Number.MAX_SAFE_INTEGER);
  if (byProducer !== 0) {
    return byProducer;
  }
  if (typeof left.desired === "number" && typeof right.desired === "number") {
    return left.desired - right.desired;
  }
  return Number(left.desired) - Number(right.desired);
}

function compareRefusals(left: PolicyPlanRefusal, right: PolicyPlanRefusal): number {
  const byCode =
    (REFUSAL_ORDER.get(left.code) ?? Number.MAX_SAFE_INTEGER) -
    (REFUSAL_ORDER.get(right.code) ?? Number.MAX_SAFE_INTEGER);
  if (byCode !== 0) {
    return byCode;
  }
  const byArtist = (left.artistId ?? 0) - (right.artistId ?? 0);
  return byArtist !== 0 ? byArtist : left.decisionKey.localeCompare(right.decisionKey);
}

function freezeCohort(draft: CohortDraft): PolicyPlanCohort {
  const ordered = [...draft.candidates].sort(compareCandidates);
  const artistIds = [...new Set(ordered.map((candidate) => candidate.artistId))];
  if (artistIds.length === 0 || artistIds.length > LIDARR_PLAN_MAX_BATCH) {
    const decisionKey = ordered[0]?.proposal.key ?? "projection";
    throw new PolicyPlanProjectionError(
      decisionKey,
      `cohort contains ${artistIds.length} unique artists; expected 1..${LIDARR_PLAN_MAX_BATCH}`,
    );
  }

  const changes = ordered.map(freezeChange);
  const firstArtistId = artistIds[0];
  const firstChange = changes[0];
  if (firstArtistId === undefined || firstChange === undefined) {
    throw new PolicyPlanProjectionError("projection", "non-empty cohort lost all projected data");
  }
  const frozenArtistIds: NonEmptyReadonlyArray<number> = Object.freeze([
    firstArtistId,
    ...artistIds.slice(1),
  ]);
  const frozenChanges: NonEmptyReadonlyArray<PolicyPlanChange> = Object.freeze([
    firstChange,
    ...changes.slice(1),
  ]);
  const cohortBase = {
    artistIds: frozenArtistIds,
    changes: frozenChanges,
  };

  switch (draft.producer) {
    case "artist-profile-assignment": {
      if (typeof draft.desired !== "number") {
        throw new PolicyPlanProjectionError(
          firstChange.decisionKey,
          "profile cohort carries a non-numeric desired target",
        );
      }
      return Object.freeze({
        ...cohortBase,
        producer: draft.producer,
        qualityProfileId: draft.desired,
      });
    }
    case "artist-monitoring": {
      if (typeof draft.desired !== "boolean") {
        throw new PolicyPlanProjectionError(
          firstChange.decisionKey,
          "monitoring cohort carries a non-boolean desired target",
        );
      }
      return Object.freeze({
        ...cohortBase,
        producer: draft.producer,
        monitored: draft.desired,
      });
    }
  }
}

function assertTotalAccounting(
  proposals: readonly PolicyProposal[],
  cohorts: readonly PolicyPlanCohort[],
  refusals: readonly PolicyPlanRefusal[],
): void {
  const accounted = [
    ...cohorts.flatMap((cohort) => cohort.changes.map((change) => change.decisionKey)),
    ...refusals.map((refusal) => refusal.decisionKey),
  ];
  const accountedSet = new Set(accounted);
  const inputKeys = new Set(proposals.map((proposal) => proposal.key));
  if (
    accounted.length !== proposals.length ||
    accountedSet.size !== accounted.length ||
    accountedSet.size !== inputKeys.size ||
    [...inputKeys].some((key) => !accountedSet.has(key))
  ) {
    throw new PolicyPlanProjectionError(
      "projection",
      `accounted for ${accountedSet.size} unique proposal keys from ${inputKeys.size}`,
    );
  }
}

/**
 * Projects every proposal into deterministic producer cohorts or refusals.
 *
 * @throws {PolicyPlanProjectionError} When evaluator data violates a bridge
 * invariant or a resulting cohort exceeds the existing Lidarr plan bound.
 */
export function projectPolicyPlan(report: PolicyEvaluationReport): PolicyPlanProjection {
  const seenKeys = new Set<PolicyDecisionKey>();
  const candidates: Candidate[] = [];
  const refusals: PolicyPlanRefusal[] = [];

  for (const proposal of report.proposals) {
    if (seenKeys.has(proposal.key)) {
      throw new PolicyPlanProjectionError(proposal.key, "proposal decision key is duplicated");
    }
    seenKeys.add(proposal.key);

    const descriptor = requireDescriptor(proposal);
    const producer = validateHandoff(proposal, descriptor);
    switch (producer) {
      case "discovery":
        refusals.push(unsupportedRefusal(proposal));
        break;
      case "artist-profile-assignment": {
        const artistId = requireAuthoritativeArtistId(proposal);
        const desired = requireProfileTarget(proposal);
        candidates.push({
          proposal,
          producer,
          artistId,
          desired,
          intentKey: `${producer}:${desired}`,
        });
        break;
      }
      case "artist-monitoring": {
        const artistId = requireAuthoritativeArtistId(proposal);
        const desired = requireMonitoringTarget(proposal);
        candidates.push({
          proposal,
          producer,
          artistId,
          desired,
          intentKey: `${producer}:${desired}`,
        });
        break;
      }
      default: {
        const exhaustive: never = producer;
        throw new PolicyPlanProjectionError(
          proposal.key,
          `handoff names unsupported producer ${JSON.stringify(exhaustive)}`,
        );
      }
    }
  }

  const intentsByArtist = new Map<number, Set<string>>();
  for (const candidate of candidates) {
    const intents = intentsByArtist.get(candidate.artistId) ?? new Set<string>();
    intents.add(candidate.intentKey);
    intentsByArtist.set(candidate.artistId, intents);
  }
  const conflictingArtists = new Set(
    [...intentsByArtist].filter(([, intents]) => intents.size > 1).map(([artistId]) => artistId),
  );

  const drafts = new Map<string, CohortDraft>();
  for (const candidate of candidates) {
    if (conflictingArtists.has(candidate.artistId)) {
      refusals.push(conflictRefusal(candidate));
      continue;
    }
    const draft = drafts.get(candidate.intentKey) ?? {
      producer: candidate.producer,
      desired: candidate.desired,
      candidates: [],
    };
    draft.candidates.push(candidate);
    drafts.set(candidate.intentKey, draft);
  }

  const cohorts = [...drafts.values()].sort(compareDrafts).map(freezeCohort);
  const orderedRefusals = refusals.sort(compareRefusals);
  assertTotalAccounting(report.proposals, cohorts, orderedRefusals);

  const projectable = cohorts.reduce((total, cohort) => total + cohort.changes.length, 0);
  const summary: PolicyPlanSummary = Object.freeze({
    proposals: report.proposals.length,
    projectable,
    refused: orderedRefusals.length,
    artifacts: 0,
  });
  return Object.freeze({
    cohorts: Object.freeze(cohorts),
    refusals: Object.freeze(orderedRefusals),
    summary,
  });
}
