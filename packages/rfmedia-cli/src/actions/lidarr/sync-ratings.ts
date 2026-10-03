/**
 * The impure orchestration edge of `rfmedia lidarr sync-ratings` (issue #221).
 *
 * Composes four shipped actions — evaluate, the two producers, apply — around
 * the pure projection in `../../lib/bridge/rating-sync.js`. It owns no decision
 * of its own: every artist it seals came out of a frozen
 * `PolicyEvaluationReport`, and every threshold it echoes was resolved by the
 * engine.
 *
 * Four properties are load-bearing:
 *
 * 1. **No scheduler slot of its own.** Every composed action already acquires a
 *    `local-only` unit, and nesting a second `runSingle` in the same lane
 *    deadlocks whenever `lidarr.scheduler` narrows that lane's concurrency to
 *    one — the hazard documented verbatim at `./policy-evaluate.ts:264-267`.
 *    {@link TIER} exists for barrel symmetry; the returned `execution` is the
 *    evaluation lane's, which is the only lane this action actually spends.
 * 2. **The forwarded `rules` array is never empty and never `undefined`.**
 *    `./policy-evaluate.ts` expands an empty selection to EVERY registered rule,
 *    including `discovery-seed`, whose proposals carry no `subject.artistId` and
 *    which the projection would then have to reject as an invariant violation.
 * 3. **`maxBatch` is bound to the cohort.** Both producers default it to
 *    `LIDARR_PLAN_DEFAULT_MAX_BATCH` (25) while `--max-proposals` allows 100, so
 *    a defaulted `maxBatch` would throw on exactly the highest-blast-radius runs
 *    — after the full Plex drain, and in apply mode after the operator approved.
 * 4. **The default `confirm` refuses.** An embedder that forgets to inject an
 *    approval path gets zero mutations, not silent ones.
 *
 * Writes nothing to Plex under any flag combination: `adapter.metadata` and
 * `updateTrackRating` are never referenced. Never writes to stdout and never
 * sets `process.exitCode` — the command owns rendering and the exit gate.
 */

import {
  SyncRatingsProjectionError,
  buildRatingSyncPlan,
  resolveSyncRatingsThresholds,
} from "../../lib/bridge/rating-sync.js";
import { LidarrPlanValidationError } from "../../lib/errors.js";
import { getLoadedPolicyConfig } from "../../lib/loaded-config.js";
import { LIDARR_PLAN_MAX_BATCH } from "../../types/lidarr-plan.js";
import { POLICY_PRODUCER_IDS } from "../../types/lidarr-policy.js";
import {
  SYNC_RATINGS_DECISION_BINDING,
  SYNC_RATINGS_DECISIONS,
  SYNC_RATINGS_SCHEMA,
} from "../../types/lidarr-sync-ratings.js";
import { executeLidarrApply } from "./apply.js";
import { executeLidarrPlan } from "./plan.js";
import { executeLidarrArtistProfilePlan } from "./plan-artist-profiles.js";
import { executeLidarrPolicyEvaluate } from "./policy-evaluate.js";
import type { RatingSyncPlan } from "../../lib/bridge/rating-sync.js";
import type { LidarrExecutionSuccessMetadata } from "../../lib/lidarr/scheduler.js";
import type { LidarrTier } from "../../lib/lidarr/tiers.js";
import type { PolicyConfigOptions } from "../../types/config.js";
import type { PolicyRuleId } from "../../types/lidarr-policy.js";
import type {
  LidarrSyncRatingsMode,
  LidarrSyncRatingsOutcome,
  LidarrSyncRatingsReport,
  SyncRatingsCohort,
  SyncRatingsDecision,
} from "../../types/lidarr-sync-ratings.js";

/**
 * Reliability tier, exported for barrel symmetry.
 *
 * This action schedules nothing itself; see the module note above.
 */
export const TIER: LidarrTier = "local-only";

/* ── Public surface ──────────────────────────────────────────────────────── */

/** Inputs for one recommend / plan / apply pass over the rating-driven rules. */
export interface LidarrSyncRatingsActionOptions {
  /** How far up the safety ladder this run is allowed to climb. */
  readonly mode: LidarrSyncRatingsMode;
  /** `--plex-library`; overrides `policy.plexLibrary`. */
  readonly plexLibrary?: string;
  /**
   * The decisions to project. Undefined or empty selects both.
   *
   * The `rules` array forwarded to the evaluate action is derived from this and
   * is therefore never empty — an empty selection there would expand to EVERY
   * registered rule, `discovery-seed` included.
   */
  readonly decisions?: readonly SyncRatingsDecision[];
  /** `--min-stars`; overrides `rating-quality-upgrade.minRating`. */
  readonly minStars?: number;
  /** `--max-plays`; overrides `stale-monitoring-cleanup.maxPlays`. */
  readonly maxPlays?: number;
  /** `--quality-profile`; overrides the rating rule's target, by name or id. */
  readonly qualityProfile?: string;
  /** `--max-proposals`; a PER-RULE cap, replacing each selected rule's own. */
  readonly maxProposals?: number;
  /** Emitted the moment an artifact is sealed, BEFORE any apply runs. */
  readonly onPlanSealed?: (outcome: LidarrSyncRatingsOutcome) => void;
  /** Forwarded RAW so the cross-origin credential guard stays live. */
  readonly plexUrl?: string;
  /** Forwarded RAW so the cross-origin credential guard stays live. */
  readonly plexToken?: string;
  /** `--lidarr-url` override. */
  readonly lidarrUrl?: string;
  /** `--lidarr-api-key` override. */
  readonly lidarrApiKey?: string;
  /** Caller cancellation, checked between every stage. */
  readonly signal?: AbortSignal;
}

/** Action result. Rendering and the exit code belong to the command. */
export interface LidarrSyncRatingsActionResult {
  readonly report: LidarrSyncRatingsReport;
  /** The evaluation lane's metadata; no second scheduler slot is acquired. */
  readonly execution: LidarrExecutionSuccessMetadata;
}

/**
 * Injectable ownership seams.
 *
 * Mirrors `LidarrPolicyEvaluateDependencies` (`./policy-evaluate.ts`): every
 * collaborator that performs I/O or reads process-wide state is named here, so
 * the tests drive the whole flow with no Plex adapter, no Lidarr client, no plan
 * directory, and no prompt.
 */
export interface LidarrSyncRatingsDependencies {
  readonly executeEvaluate: typeof executeLidarrPolicyEvaluate;
  readonly buildPlan: typeof buildRatingSyncPlan;
  readonly resolveThresholds: typeof resolveSyncRatingsThresholds;
  readonly executeArtistProfilePlan: typeof executeLidarrArtistProfilePlan;
  readonly executeMonitoringPlan: typeof executeLidarrPlan;
  readonly executeApply: typeof executeLidarrApply;
  readonly loadedPolicyConfig: typeof getLoadedPolicyConfig;
  /**
   * Approval collaborator, consulted ONCE per sealed artifact in `"apply"` mode.
   *
   * The default REFUSES: an embedder that forgets to inject an approval path
   * gets zero mutations, not silent ones.
   */
  readonly confirm: (outcome: LidarrSyncRatingsOutcome) => Promise<boolean>;
}

const DEFAULT_DEPENDENCIES: LidarrSyncRatingsDependencies = Object.freeze({
  executeEvaluate: executeLidarrPolicyEvaluate,
  buildPlan: buildRatingSyncPlan,
  resolveThresholds: resolveSyncRatingsThresholds,
  executeArtistProfilePlan: executeLidarrArtistProfilePlan,
  executeMonitoringPlan: executeLidarrPlan,
  executeApply: executeLidarrApply,
  loadedPolicyConfig: getLoadedPolicyConfig,
  confirm: async () => false,
});

/* ── Internals ───────────────────────────────────────────────────────────── */

/** The raw `policy.rules.<id>.enabled` tri-state, before any override. */
type DecisionState = "on" | "unset" | "off";

/** Per-decision view of the raw tri-state, uncontaminated by force-enable. */
type DecisionStateMap = Readonly<Record<SyncRatingsDecision, DecisionState>>;

/**
 * Reads one rule's RAW `enabled` tri-state out of the loaded config.
 *
 * `resolvePolicyConfig` collapses `undefined` and `false` to the same `false`,
 * so the distinction — never configured versus deliberately switched off —
 * survives only here.
 *
 * @param config - Raw `policy:` config, or undefined when the section is absent.
 * @param ruleId - The rule bound to a decision.
 * @returns The tri-state.
 */
function readDecisionState(
  config: PolicyConfigOptions | undefined,
  ruleId: PolicyRuleId,
): DecisionState {
  const enabled = config?.rules?.[ruleId]?.enabled;
  if (enabled === undefined) {
    return "unset";
  }
  return enabled ? "on" : "off";
}

/**
 * Projects the raw tri-state for both decisions.
 *
 * `satisfies` makes a future third decision a compile error rather than a
 * missing key the presenter would read as `undefined`.
 *
 * @param config - Raw `policy:` config, or undefined when the section is absent.
 * @returns The frozen per-decision tri-state echoed on the report.
 */
function resolveDecisionStates(config: PolicyConfigOptions | undefined): DecisionStateMap {
  return Object.freeze({
    "quality-profile": readDecisionState(
      config,
      SYNC_RATINGS_DECISION_BINDING["quality-profile"].ruleId,
    ),
    monitoring: readDecisionState(config, SYNC_RATINGS_DECISION_BINDING.monitoring.ruleId),
  } satisfies Record<SyncRatingsDecision, DecisionState>);
}

/**
 * Normalises the `--decision` selection into declaration order.
 *
 * An absent or empty selection means BOTH decisions, never "every registered
 * rule": `discovery-seed` has no producer and can never be sealed.
 *
 * @param decisions - The caller's selection, or undefined.
 * @returns The selection, deduplicated, in declaration order, never empty.
 */
function resolveSelectedDecisions(
  decisions: readonly SyncRatingsDecision[] | undefined,
): readonly SyncRatingsDecision[] {
  if (decisions === undefined || decisions.length === 0) {
    return SYNC_RATINGS_DECISIONS;
  }
  return Object.freeze(SYNC_RATINGS_DECISIONS.filter((decision) => decisions.includes(decision)));
}

/**
 * Orders the sealable cohorts by `POLICY_PRODUCER_IDS` declaration order.
 *
 * Sealing is ordered but not atomic, so a partial failure must always leave the
 * same prefix of artifacts on disk.
 *
 * @param cohorts - Every cohort the projection emitted.
 * @returns Only the sealable cohorts, profile first, monitoring second.
 */
function orderSealableCohorts(cohorts: readonly SyncRatingsCohort[]): readonly SyncRatingsCohort[] {
  return POLICY_PRODUCER_IDS.flatMap((producer) =>
    cohorts.filter((cohort) => cohort.gate === "sealable" && cohort.producer === producer),
  );
}

/**
 * Two-sided cohort bound check, refusing with this feature's own message.
 *
 * The lower bound matters as much as the upper: both producers reject an empty
 * id list, and the plan engine enforces `LIDARR_PLAN_MAX_BATCH` and the
 * identical `LIDARR_PLAN_MAX_ENTRIES` independently with a terser message.
 *
 * @param cohort - A cohort about to be handed to its producer.
 * @returns The cohort size, which is also the `maxBatch` to bind.
 * @throws {LidarrPlanValidationError} When the cohort is empty or over the cap.
 */
function requireSealableCohortSize(cohort: SyncRatingsCohort): number {
  const size = cohort.artistIds.length;
  if (size < 1 || size > LIDARR_PLAN_MAX_BATCH) {
    throw new LidarrPlanValidationError(
      `the ${cohort.decision} cohort holds ${size} artists, outside the sealable range 1..${LIDARR_PLAN_MAX_BATCH}`,
    );
  }
  return size;
}

/**
 * Seals one cohort into an immutable plan artifact.
 *
 * The profile producer is bound by `String(resolvedProfileId)` — the id the rule
 * actually decided on — and never by `qualityProfileName`, because
 * `resolveLidarrProfileReference` tests a numeric pattern BEFORE any name match
 * and throws on an ambiguous name.
 *
 * @param cohort - A sealable cohort.
 * @param options - Connection overrides.
 * @param dependencies - Injected collaborators.
 * @returns The sealed outcome, with no apply result yet.
 * @throws {SyncRatingsProjectionError} When a sealable profile cohort carries no
 *   numeric `resolvedProfileId`, or a monitoring cohort no desired state.
 * @throws {LidarrPlanValidationError} When the cohort is empty or over the cap.
 */
async function sealCohort(
  cohort: SyncRatingsCohort,
  options: LidarrSyncRatingsActionOptions,
  dependencies: LidarrSyncRatingsDependencies,
): Promise<LidarrSyncRatingsOutcome> {
  const maxBatch = requireSealableCohortSize(cohort);
  const connection = { lidarrUrl: options.lidarrUrl, lidarrApiKey: options.lidarrApiKey };
  const identity = {
    decision: cohort.decision,
    ruleId: cohort.ruleId,
    producer: cohort.producer,
  };

  if (cohort.producer === "artist-profile-assignment") {
    const resolvedProfileId = cohort.resolvedProfileId;
    if (typeof resolvedProfileId !== "number") {
      throw new SyncRatingsProjectionError(
        cohort.ruleId,
        "a sealable profile cohort carries no numeric resolvedProfileId to bind the producer to",
      );
    }
    const generated = await dependencies.executeArtistProfilePlan({
      artistIds: cohort.artistIds,
      qualityProfile: String(resolvedProfileId),
      maxBatch,
      ...connection,
    });
    return Object.freeze({ ...identity, generated });
  }

  const monitored = cohort.desiredMonitored;
  if (typeof monitored !== "boolean") {
    throw new SyncRatingsProjectionError(
      cohort.ruleId,
      "a sealable monitoring cohort carries no desired monitored state",
    );
  }
  const generated = await dependencies.executeMonitoringPlan({
    artistIds: cohort.artistIds,
    monitored,
    maxBatch,
    ...connection,
  });
  return Object.freeze({ ...identity, generated });
}

/**
 * Consults the approval seam and, when granted, applies one sealed artifact.
 *
 * Both `expectedPlanId` and `expectedPlanChecksum` are pinned from the artifact
 * just written, so an artifact swapped, regenerated, or truncated between seal
 * and apply becomes a loud failure instead of an apply of the wrong state.
 *
 * @param outcome - One sealed artifact.
 * @param options - Connection overrides and cancellation.
 * @param dependencies - Injected collaborators.
 * @returns The outcome, carrying its apply result only when approved.
 * @throws {DOMException} `AbortError`, when `signal` is already aborted.
 */
async function applyOutcome(
  outcome: LidarrSyncRatingsOutcome,
  options: LidarrSyncRatingsActionOptions,
  dependencies: LidarrSyncRatingsDependencies,
): Promise<LidarrSyncRatingsOutcome> {
  options.signal?.throwIfAborted();
  if (!(await dependencies.confirm(outcome))) {
    return outcome;
  }
  const apply = await dependencies.executeApply({
    planPath: outcome.generated.planPath,
    dryRun: false,
    approved: true,
    expectedPlanId: outcome.generated.plan.id,
    expectedPlanChecksum: outcome.generated.plan.payloadChecksum,
    lidarrUrl: options.lidarrUrl,
    lidarrApiKey: options.lidarrApiKey,
    signal: options.signal,
  });
  return Object.freeze({ ...outcome, apply });
}

/**
 * Walks the safety ladder: recommend stops here, plan seals, apply mutates.
 *
 * Sealing is sequential and ordered rather than concurrent: the producers
 * re-read live Lidarr state, and `onPlanSealed` must reach the operator with
 * artifact #1's path before artifact #2 can fail the run.
 *
 * @param plan - The projected cohorts.
 * @param options - Mode, cancellation, and connection overrides.
 * @param dependencies - Injected collaborators.
 * @returns The frozen outcomes, in producer declaration order.
 * @throws {DOMException} `AbortError`, when `signal` aborts between stages.
 */
async function runMutationLadder(
  plan: RatingSyncPlan,
  options: LidarrSyncRatingsActionOptions,
  dependencies: LidarrSyncRatingsDependencies,
): Promise<readonly LidarrSyncRatingsOutcome[]> {
  if (options.mode === "recommend") {
    return Object.freeze([]);
  }

  const sealed: LidarrSyncRatingsOutcome[] = [];
  for (const cohort of orderSealableCohorts(plan.cohorts)) {
    options.signal?.throwIfAborted();
    const outcome = await sealCohort(cohort, options, dependencies);
    sealed.push(outcome);
    options.onPlanSealed?.(outcome);
  }

  if (options.mode === "plan") {
    return Object.freeze(sealed);
  }

  const applied: LidarrSyncRatingsOutcome[] = [];
  for (const outcome of sealed) {
    applied.push(await applyOutcome(outcome, options, dependencies));
  }
  return Object.freeze(applied);
}

/* ── Entrypoint ──────────────────────────────────────────────────────────── */

/**
 * Runs one recommend / plan / apply pass over the rating-driven policy rules.
 *
 * Schedules no work of its own: every composed action already acquires its own
 * `local-only` slot, and nesting `runSingle` deadlocks a lane narrowed to
 * concurrency 1. Writes nothing to Plex under any flag combination, never writes
 * to stdout, and never sets `process.exitCode`.
 *
 * @param options - Mode, selection, thresholds, and connection overrides.
 * @param dependencies - Injected collaborators; defaults to the real ones.
 * @returns The frozen report plus the evaluation lane's execution metadata.
 * @throws {Error} From the artist-profile producer — a vanished artist id, an
 *   unresolvable target or BEFORE-state profile, or an over-cap cohort all
 *   surface as plain `Error`/`TypeError` from `src/lib/lidarr/artist-selection.ts`.
 * @throws {LidarrPlanValidationError} From the monitoring producer's vanished-id
 *   check, from the plan engine's `maxBatch`/entry caps, and from this action's
 *   own two-sided cohort assertion.
 * @throws {SyncRatingsProjectionError} When the engine violated an invariant the
 *   projection or the producer binding depends on.
 * @throws {DOMException} `AbortError`, when `signal` aborts between stages.
 */
export async function executeLidarrSyncRatings(
  options: LidarrSyncRatingsActionOptions,
  dependencies: LidarrSyncRatingsDependencies = DEFAULT_DEPENDENCIES,
): Promise<LidarrSyncRatingsActionResult> {
  options.signal?.throwIfAborted();

  const decisions = resolveSelectedDecisions(options.decisions);
  const config = dependencies.loadedPolicyConfig();
  const decisionStates = resolveDecisionStates(config);
  const forceEnableRules = new Set<PolicyRuleId>(
    decisions
      .filter((decision) => decisionStates[decision] === "unset")
      .map((decision) => SYNC_RATINGS_DECISION_BINDING[decision].ruleId),
  );

  const evaluation = await dependencies.executeEvaluate({
    rules: decisions.map((decision) => SYNC_RATINGS_DECISION_BINDING[decision].ruleId),
    plexLibrary: options.plexLibrary,
    maxProposals: options.maxProposals,
    ratingMinRating: options.minStars,
    ratingTargetQualityProfile: options.qualityProfile,
    staleMaxPlays: options.maxPlays,
    forceEnableRules,
    plexUrl: options.plexUrl,
    plexToken: options.plexToken,
    lidarrUrl: options.lidarrUrl,
    lidarrApiKey: options.lidarrApiKey,
    signal: options.signal,
  });
  options.signal?.throwIfAborted();

  const plan = dependencies.buildPlan({
    report: evaluation.report,
    decisions,
    disabledDecisions: new Set<SyncRatingsDecision>(
      SYNC_RATINGS_DECISIONS.filter((decision) => decisionStates[decision] === "off"),
    ),
  });
  const thresholds = dependencies.resolveThresholds({
    report: evaluation.report,
    config,
    overrides: {
      minStars: options.minStars,
      maxPlays: options.maxPlays,
      qualityProfile: options.qualityProfile,
      maxProposals: options.maxProposals,
    },
  });

  const outcomes = await runMutationLadder(plan, options, dependencies);

  return Object.freeze({
    report: Object.freeze({
      schema: SYNC_RATINGS_SCHEMA,
      mode: options.mode,
      decisions,
      thresholds,
      cohorts: plan.cohorts,
      refusals: plan.refusals,
      footprint: plan.footprint,
      outcomes,
      evaluation: evaluation.report,
      decisionStates,
    }),
    execution: evaluation.execution,
  });
}
