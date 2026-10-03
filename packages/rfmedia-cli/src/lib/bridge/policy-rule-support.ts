/**
 * Shared evaluator primitives for the consumption policy rules (issue #209,
 * design §4.1). Role analogue of `src/lib/lidarr/audit-check-support.ts`.
 *
 * Zero I/O: nothing here may import a client, an adapter, or a database module.
 * This module also declares NO types — every shape comes from
 * `../../types/lidarr-policy.js`, exactly as `audit-check-support.ts` type-imports
 * `LidarrAuditSlot` / `LidarrAuditSubject` rather than redeclaring them.
 *
 * The single most load-bearing property in the file is that
 * {@link createPolicyProposal} requires a `PolicyIdentityLink`. That brand can
 * only be minted by `indexAuthoritativeIdentities` in `./policy-signals.js`,
 * which admits only `ReconciliationAuthoritativeItem` values. Review-grade name
 * evidence therefore cannot reach a mutation-bound proposal without a
 * deliberate type change (design §8.3).
 */

import type {
  PolicyDecisionCode,
  PolicyDecisionKey,
  PolicyHandoff,
  PolicyIdentityBasis,
  PolicyIdentityLink,
  PolicyObservation,
  PolicyProducerId,
  PolicyProposal,
  PolicyRuleId,
  PolicySignal,
  PolicySignalSlot,
  PolicySkip,
  PolicySkipCode,
  PolicySubject,
  PolicyThresholdCheck,
} from "../../types/lidarr-policy.js";
import type { MediaFilterRule } from "../../types/media-filters.js";
import type { MediaArtist } from "../../types/media-server.js";
import { evaluateMediaFilterRule } from "../media-filter-evaluator.js";

/** The rule id every inert discovery seed is attributed to. */
const SEED_RULE_ID: PolicyRuleId = "discovery-seed";

/** The only decision code an inert discovery seed may carry. */
const SEED_DECISION_CODE: PolicyDecisionCode = "high-signal-discovery-seed";

/**
 * Identity evidence carried by every authoritative decision.
 *
 * A `PolicyIdentityLink` is minted only from a `ReconciliationAuthoritativeItem`,
 * whose `category` / `reason` pair is literal-typed in `../../types/bridge.js`,
 * so the basis is a constant rather than something a caller may supply.
 */
const AUTHORITATIVE_IDENTITY: PolicyIdentityBasis = Object.freeze({
  category: "authoritative",
  reason: "unique-exact-mbid",
});

/** Argv tokens a handoff may never contain (design §7.1 item 5). */
const FORBIDDEN_HANDOFF_TOKENS: ReadonlySet<string> = new Set(["apply", "--plan-file"]);

/**
 * Builds the decision key for an authoritative link.
 *
 * @param ruleId - The rule that produced the decision.
 * @param lidarrId - The Lidarr artist id the decision acts on.
 * @returns The stable, non-rotating decision key.
 */
export function policyArtistKey(ruleId: PolicyRuleId, lidarrId: number): PolicyDecisionKey {
  return `${ruleId}:artist:${lidarrId}`;
}

/**
 * Builds the decision key for a Plex-only subject.
 *
 * @param ruleId - The rule that produced the decision.
 * @param plexId - The Plex rating key of the subject.
 * @returns The stable, non-rotating decision key.
 */
export function policyPlexKey(ruleId: PolicyRuleId, plexId: string): PolicyDecisionKey {
  return `${ruleId}:plex:${plexId}`;
}

/**
 * Freezes a check list and every check inside it.
 *
 * @param checks - Checks in evaluation order.
 * @returns The same list, frozen.
 */
function freezeChecks(checks: readonly PolicyThresholdCheck[]): readonly PolicyThresholdCheck[] {
  for (const check of checks) {
    Object.freeze(check);
  }
  return Object.freeze(checks);
}

/**
 * Freezes a flat scalar state record.
 *
 * @param state - A `before` or `after` record.
 * @returns The same record, frozen.
 */
function freezeState(
  state: Readonly<Record<string, string | number | boolean | null>>,
): Readonly<Record<string, string | number | boolean | null>> {
  return Object.freeze(state);
}

/**
 * Freezes an observation record and every observation inside it.
 *
 * @param observations - Per-signal observations keyed by signal name.
 * @returns The same record, frozen.
 */
function freezeObservations(
  observations: Readonly<Record<string, PolicyObservation<number | boolean>>>,
): Readonly<Record<string, PolicyObservation<number | boolean>>> {
  for (const observation of Object.values(observations)) {
    Object.freeze(observation);
  }
  return Object.freeze(observations);
}

/**
 * Freezes a handoff and its argument vector.
 *
 * @param handoff - The inert follow-up.
 * @returns The same handoff, frozen.
 */
function freezeHandoff(handoff: PolicyHandoff): PolicyHandoff {
  Object.freeze(handoff.argv);
  return Object.freeze(handoff);
}

/**
 * THE ONLY constructor for a mutation-bound proposal.
 *
 * Requires a {@link PolicyIdentityLink}, which only `indexAuthoritativeIdentities`
 * can mint. Deep-freezes the proposal together with its `checks`, `before`,
 * `after`, and `observations` so a downstream presenter or serializer cannot
 * mutate evidence after the fact.
 *
 * @param input - The rule's verdict material.
 * @returns The frozen proposal.
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
}): PolicyProposal {
  // Id keys stay SINGULAR (`artistId`, never `artistIds`) so the structural
  // `lidarr-editor-body-owner` architecture rule is unreachable by construction.
  const subject: PolicySubject = Object.freeze({
    kind: "artist",
    name: input.link.lidarrTitle,
    plexId: input.link.plexId,
    artistId: input.link.lidarrId,
    artistMbid: input.link.artistMbid,
  });

  return Object.freeze({
    key: policyArtistKey(input.ruleId, input.link.lidarrId),
    ruleId: input.ruleId,
    code: input.code,
    subject,
    identity: AUTHORITATIVE_IDENTITY,
    before: freezeState(input.before),
    after: freezeState(input.after),
    checks: freezeChecks(input.checks),
    observations: freezeObservations(input.observations),
    summary: input.summary,
    handoff: freezeHandoff(input.handoff),
  });
}

/**
 * Narrow constructor for an INERT seed.
 *
 * A seed has no Lidarr counterpart and therefore no {@link PolicyIdentityLink}.
 * `handoff.producer` is fixed to `"discovery"` and the emitted subject carries
 * no `artistId`, so a seed can never be routed to a mutation producer even if a
 * caller supplied a subject that had one.
 *
 * @param input - The seed's verdict material.
 * @returns The frozen inert proposal.
 */
export function createPolicySeedProposal(input: {
  readonly subject: PolicySubject;
  readonly identity: PolicyIdentityBasis;
  readonly checks: readonly PolicyThresholdCheck[];
  readonly observations: Readonly<Record<string, PolicyObservation<number | boolean>>>;
  readonly summary: string;
  readonly seedArtistName: string;
}): PolicyProposal {
  const subject: PolicySubject = Object.freeze({
    kind: "artist",
    name: input.subject.name,
    plexId: input.subject.plexId,
    artistMbid: input.subject.artistMbid,
  });

  return Object.freeze({
    key: policyPlexKey(SEED_RULE_ID, subject.plexId),
    ruleId: SEED_RULE_ID,
    code: SEED_DECISION_CODE,
    subject,
    identity: Object.freeze(input.identity),
    before: freezeState({ inLidarr: false }),
    after: freezeState({ inLidarr: false }),
    checks: freezeChecks(input.checks),
    observations: freezeObservations(input.observations),
    summary: input.summary,
    handoff: buildPolicyHandoff("discovery", [
      "lidarr",
      "discover",
      "--artist",
      input.seedArtistName,
    ]),
  });
}

/**
 * Skip constructor. Accepts a non-authoritative subject by design: refusals are
 * data, and the review-grade subjects §6.0 refuses are exactly the ones that can
 * never mint a link.
 *
 * The skip key carries the skip CODE as its last segment — `<ruleId>:artist:<id>:<code>`
 * or `<ruleId>:plex:<id>:<code>` — because rule + subject alone is not total for
 * refusals. One subject can legitimately draw two refusals from the same rule:
 * `stale-monitoring-cleanup` refuses a `lidarrOnly` artist with
 * `no-consumption-coverage` while the §6.0 universal refusal attributes
 * `identity-not-authoritative` to the same subject, and `discovery-seed` seeds a
 * `plexOnly` artist that the same §6.0 pass also refuses. Without the code both
 * rows would share a key, and `--explain <key>` would render whichever record
 * `.find()` reached first. Proposal keys stay `<ruleId>:<side>:<id>`: a rule
 * proposes at most one change per subject.
 *
 * @param input - The refusal material.
 * @returns The frozen skip.
 */
export function createPolicySkip(input: {
  readonly ruleId: PolicyRuleId;
  readonly code: PolicySkipCode;
  readonly subject: PolicySubject;
  readonly identity: PolicyIdentityBasis;
  readonly checks?: readonly PolicyThresholdCheck[];
  readonly detail: string;
}): PolicySkip {
  const subjectKey =
    input.subject.artistId === undefined
      ? policyPlexKey(input.ruleId, input.subject.plexId)
      : policyArtistKey(input.ruleId, input.subject.artistId);
  const key: PolicyDecisionKey = `${subjectKey}:${input.code}`;

  return Object.freeze({
    key,
    ruleId: input.ruleId,
    code: input.code,
    subject: Object.freeze(input.subject),
    identity: Object.freeze(input.identity),
    checks: freezeChecks(input.checks ?? []),
    detail: input.detail,
  });
}

/**
 * Decides whether an argv element is an option VALUE rather than argv structure.
 *
 * An element is a value exactly when it follows a `--`-prefixed token and does
 * not itself start with `--`. That is the only position library-derived data
 * ever occupies in a policy handoff — a Plex artist title after `--artist`, a
 * Lidarr quality-profile name after `--quality-profile` — and it is the position
 * the forbidden-token assertion must NOT police. A chained flag
 * (`--foo --plan-file`) still starts with `--`, so it stays checked.
 *
 * @param args - The complete machine argument vector.
 * @param index - The element's position in that vector.
 * @returns True when the element is an option value.
 */
function isHandoffOptionValue(args: readonly string[], index: number): boolean {
  const token = args[index];
  if (index === 0 || token === undefined || token.startsWith("--")) {
    return false;
  }
  return args[index - 1]?.startsWith("--") ?? false;
}

/**
 * The one argv builder — the pluggable action-emitter seam, deliberately a
 * function over a data table rather than an emitter framework.
 *
 * INVARIANT: the returned argv never names `"apply"` and never names
 * `"--plan-file"` in a STRUCTURAL position — the leading verb segment and the
 * option names. Omitting `--plan-file` lets the existing producer default to
 * `defaultOutputPath` under `getDefaultPlanDir()` instead of scattering
 * artifacts into whatever directory the operator happened to be standing in.
 * A caller that supplies either token there has written a bug, so this throws
 * rather than silently stripping it.
 *
 * Option VALUES are exempt (see {@link isHandoffOptionValue}) because they are
 * library data, not code: a Plex artist or a Lidarr quality profile literally
 * titled "apply" is a legal library string, and asserting on it would turn the
 * whole rule into a `rule-error` skip and delete every proposal it had made
 * (§7.1 item 5 asserts on the verb positions, never on operator data).
 *
 * @param producer - The producer the proposal hands off to.
 * @param args - The complete machine argument vector.
 * @returns The frozen handoff.
 * @throws {Error} When a structural position names `apply` or `--plan-file`.
 */
export function buildPolicyHandoff(
  producer: PolicyProducerId | "discovery",
  args: readonly string[],
): PolicyHandoff {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined || isHandoffOptionValue(args, index)) {
      continue;
    }
    if (FORBIDDEN_HANDOFF_TOKENS.has(token)) {
      throw new Error(
        `policy handoff argv must never contain "${token}"; evaluation proposes, it never applies`,
      );
    }
  }

  return freezeHandoff({ producer, argv: [...args] });
}

/**
 * Unwraps a declared required slot, refusing to guess when it is absent.
 *
 * The engine dispatches an evaluator only once every `requires` entry is
 * available, so reaching the throw means the registry and the evaluator
 * disagree. Surfacing that as a `rule-error` rule skip is honest; returning an
 * empty verdict would report a clean rule over data that was never read.
 *
 * @param slot - The gathered slot to unwrap.
 * @param ruleId - Rule id, for the invariant-violation message.
 * @param signal - Signal name, for the invariant-violation message.
 * @returns The slot's data.
 * @throws {Error} When the slot is unavailable.
 */
export function requireSignal<T>(
  slot: PolicySignalSlot<T>,
  ruleId: PolicyRuleId,
  signal: PolicySignal,
): T {
  if (slot.status !== "available") {
    throw new Error(
      `policy rule ${ruleId} requires the ${signal} signal, which the engine reported unavailable`,
    );
  }
  return slot.data;
}

/**
 * Evaluates a star-scale rating threshold through the ONE shipped
 * implementation.
 *
 * Delegates to `evaluateMediaFilterRule`, inheriting both the star to
 * normalized conversion and the `rating === null` to `undefined` to `false`
 * fail-closed semantic. `starRatingToNormalized` is never re-implemented here.
 *
 * The comparator parameter is typed `">=" | "<="` on purpose:
 * `evaluateMediaFilterRule` returns TRUE for `"!="` / `"not_contains"` when the
 * field value is undefined, which would invert the fail-closed property on an
 * unrated artist and let a rating veto pass silently.
 *
 * @param artist - The Plex artist carrying the normalized rating.
 * @param comparator - The star comparison to apply.
 * @param starBound - The bound on the public 1-5 star input scale.
 * @param configPath - The dotted `.rfmedia.yaml` key behind the bound.
 * @returns The evaluated threshold check.
 * @throws {RangeError} When the bound is outside 1-5 or the artist carries an
 * invalid normalized rating.
 */
export function checkArtistRating(
  artist: MediaArtist,
  comparator: ">=" | "<=",
  starBound: number,
  configPath: string,
): PolicyThresholdCheck {
  const rule: MediaFilterRule = {
    type: "rule",
    field: "artistRating",
    operator: comparator,
    value: starBound,
  };

  return {
    signal: "plexArtistRatings",
    label: `Plex artist rating ${comparator} ${starBound} stars`,
    comparator,
    bound: starBound,
    observed: toStarScale(artist.rating),
    satisfied: evaluateMediaFilterRule(rule, artist),
    configPath,
  };
}

/**
 * Projects a normalized 0-1 rating back onto the reported 1-5 star scale.
 *
 * Reported at two decimals so a report never shows `3.4999999999999996` for a
 * three-and-a-half star artist. The comparison itself is performed on the
 * normalized value by `evaluateMediaFilterRule`, never on this projection.
 *
 * @param rating - Normalized rating, or null when the artist is unrated.
 * @returns The star-scale rating, or null when unrated.
 */
function toStarScale(rating: number | null): number | null {
  return rating === null ? null : Math.round(rating * 500) / 100;
}
