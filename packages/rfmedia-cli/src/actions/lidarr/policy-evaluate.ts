/**
 * The impure edge of `rfmedia lidarr policy evaluate` (issue #209, design §11,
 * §7.1, §3, §8.1, §14.7, §2.5).
 *
 * This module owns the only I/O the evaluation flow performs and the only place
 * its read-only guarantee can be broken by accident. Everything it calls is
 * either a never-throw gatherer (`./policy-gather.js`), the shipped read-only
 * reconciliation (`./reconcile.js`), or a pure function
 * (`../../lib/bridge/policy-engine.js`).
 *
 * Three properties are load-bearing:
 *
 * 1. **ZERO WRITES (§7.1).** No plan writer is imported —
 *    `writeLidarrPlanArtifact`, `appendLidarrPlanHistory`, and
 *    `acquireLidarrPlanClaim` appear nowhere — and no `LidarrClientApi` mutation
 *    method is called, so no module here belongs in any
 *    `LIDARR_MUTATION_OWNERSHIP_RULES` owners `Set`. `adapter.metadata` and
 *    `updateTrackRating` are never referenced. The single write in the whole
 *    flow is the pre-existing observational `bridge_identity_snapshots` replace
 *    performed *inside* `executeLidarrReconcile`.
 * 2. **The gather plan is derived, never assumed (§8.1 item 7).** Only signals
 *    in `requiredSignalsFor(selected) ∪ enrichedSignalsFor(selected)` are
 *    gathered; everything else is a `not-requested` slot. `plex.cache.enabled`
 *    defaults to `false`, so gathering unconditionally would turn
 *    `--rule rating-quality-upgrade` — a run that needs no play data at all —
 *    into a full-library track drain.
 * 3. **The command owns the output boundary.** This action returns a frozen
 *    result, writes nothing to stdout, and never sets `process.exitCode`.
 *
 * There is no `--offline` path and no `--plex-library-id` (§2.5): consumption
 * requires a live Plex read, and `bridge_identity_snapshots` carries zero
 * consumption evidence, so an offline run could only emit skips.
 */

import { resolvePolicyConfig, runLidarrPolicyEvaluation } from "../../lib/bridge/policy-engine.js";
import { indexAuthoritativeIdentities } from "../../lib/bridge/policy-signals.js";
import { resolveLidarrScheduler } from "../../lib/lidarr/index.js";
import { getLoadedPolicyConfig } from "../../lib/loaded-config.js";
import { logDebug } from "../../lib/logger.js";
import {
  POLICY_RULE_IDS,
  enrichedSignalsFor,
  requiredSignalsFor,
} from "../../types/lidarr-policy.js";
import {
  gatherLidarrArtists,
  gatherLidarrQualityProfiles,
  gatherPlexArtistRatings,
  gatherPlexTrackPlays,
} from "./policy-gather.js";
import { executeLidarrReconcile } from "./reconcile.js";
import type { PolicyEvaluationOverrides } from "../../lib/bridge/policy-engine.js";
import type {
  LidarrExecutionSuccessMetadata,
  LidarrScheduler,
} from "../../lib/lidarr/scheduler.js";
import type { LidarrTier } from "../../lib/lidarr/tiers.js";
import type {
  PolicyEvaluationReport,
  PolicyRuleId,
  PolicySignal,
  PolicySignalBundle,
  PolicySignalSlot,
} from "../../types/lidarr-policy.js";

/**
 * Reliability tier for the whole evaluation.
 *
 * Every read is a plain Lidarr or Plex query; no upstream metadata provider is
 * consulted and nothing is mutated, which is exactly the `local-only` contract.
 */
export const TIER: LidarrTier = "local-only";

/** Human-readable operation name carried on scheduler execution metadata. */
const OPERATION = "lidarr policy evaluate";

/** Stable scheduler task id for the single scheduled unit of work. */
const TASK_ID = "lidarr-policy-evaluate";

/** Ceiling on any slot `detail`, matching the gatherers' own bound. */
const POLICY_EVALUATE_DETAIL_MAX = 300;

/**
 * Origin echoed when the identity bridge could not be built.
 *
 * The canonical credential-free origins are a property of the reconciliation
 * scope, so an unavailable bridge slot leaves the report with nothing honest to
 * name. Inventing a value from CLI overrides would report an origin no read
 * actually used.
 */
const UNKNOWN_ORIGIN = "unknown";

/* ── Public surface ──────────────────────────────────────────────────────── */

/** Inputs for one read-only consumption-policy evaluation. */
export interface LidarrPolicyEvaluateActionOptions {
  /** `--plex-library`; overrides `policy.plexLibrary` (§10.1, §16.2). */
  readonly plexLibrary?: string;
  /**
   * Rule ids the operator selected with `--rule`.
   *
   * Already narrowed to {@link PolicyRuleId} by the command, which validates
   * inside its `.action()` handler — a Commander `argParser` that throws exits
   * the process before the failure envelope exists. Undefined or empty selects
   * every registered rule.
   */
  readonly rules?: readonly PolicyRuleId[];
  /** `--max-proposals`; one global per-rule cap override (§16.2). */
  readonly maxProposals?: number;
  /**
   * `rating-quality-upgrade.minRating` override.
   *
   * #221 sync-ratings is the sole consumer; the policy leaf never sets it.
   */
  readonly ratingMinRating?: number;
  /**
   * `rating-quality-upgrade.targetQualityProfile` override, by name or id.
   *
   * #221 sync-ratings is the sole consumer; the policy leaf never sets it.
   */
  readonly ratingTargetQualityProfile?: string;
  /**
   * `stale-monitoring-cleanup.maxPlays` override.
   *
   * #221 sync-ratings is the sole consumer; the policy leaf never sets it.
   */
  readonly staleMaxPlays?: number;
  /**
   * Rule ids to treat as enabled for this invocation alone.
   *
   * #221 sync-ratings is the sole consumer; the policy leaf never sets it.
   */
  readonly forceEnableRules?: ReadonlySet<PolicyRuleId>;
  /** `--plex-url` override, forwarded RAW to the gatherers. */
  readonly plexUrl?: string;
  /** `--plex-token` override, forwarded RAW to the gatherers. */
  readonly plexToken?: string;
  /** `--lidarr-url` override. */
  readonly lidarrUrl?: string;
  /** `--lidarr-api-key` override. */
  readonly lidarrApiKey?: string;
  /** Caller cancellation, propagated through scheduling and every read. */
  readonly signal?: AbortSignal;
}

/** Action result. Rendering and the exit code belong to the command. */
export interface LidarrPolicyEvaluateActionResult {
  readonly report: PolicyEvaluationReport;
  /** Scheduler metadata for the evaluation lane. */
  readonly execution: LidarrExecutionSuccessMetadata;
}

/**
 * Injectable ownership seams.
 *
 * Mirrors `LidarrReconcileDependencies` (`./reconcile.ts`): every collaborator
 * that performs I/O, reads process-wide state, or reads the clock is named
 * here, so the command test can drive the whole flow without a Plex adapter, a
 * Lidarr client, or the tracking database.
 */
export interface LidarrPolicyEvaluateDependencies {
  readonly executeReconcile: typeof executeLidarrReconcile;
  readonly gatherLidarrArtists: typeof gatherLidarrArtists;
  readonly gatherLidarrQualityProfiles: typeof gatherLidarrQualityProfiles;
  readonly gatherPlexArtistRatings: typeof gatherPlexArtistRatings;
  readonly gatherPlexTrackPlays: typeof gatherPlexTrackPlays;
  readonly resolveScheduler: () => Pick<LidarrScheduler, "runSingle">;
  readonly loadedPolicyConfig: typeof getLoadedPolicyConfig;
  /**
   * The identity indexer named by design §11.
   *
   * The pure engine constructs its own indexes from the gathered slots
   * (`runLidarrPolicyEvaluation` → `buildIndexes`), so this action does not
   * invoke it: doing so would re-walk the whole reconciliation report to
   * produce a value the engine immediately recomputes. It stays on the seam
   * because the identity substrate is part of this action's declared
   * collaborator set and the brand on `PolicyIdentityLink` makes this the only
   * sanctioned way to mint one.
   */
  readonly indexAuthoritativeIdentities: typeof indexAuthoritativeIdentities;
  readonly runEvaluation: typeof runLidarrPolicyEvaluation;
  readonly now: () => Date;
}

const DEFAULT_DEPENDENCIES: LidarrPolicyEvaluateDependencies = Object.freeze({
  executeReconcile: executeLidarrReconcile,
  gatherLidarrArtists,
  gatherLidarrQualityProfiles,
  gatherPlexArtistRatings,
  gatherPlexTrackPlays,
  resolveScheduler: resolveLidarrScheduler,
  loadedPolicyConfig: getLoadedPolicyConfig,
  indexAuthoritativeIdentities,
  runEvaluation: runLidarrPolicyEvaluation,
  now: () => new Date(),
});

/* ── Internals ───────────────────────────────────────────────────────────── */

/**
 * The `unavailable` arm of any slot. It names no payload type, so one value is
 * assignable to every `PolicySignalSlot<T>`.
 */
type PolicyUnavailableSlot = Extract<PolicySignalSlot<unknown>, { readonly status: "unavailable" }>;

/** Extracts a human-readable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Clamps a detail so no single slot can dominate a `--json` report. */
function boundedDetail(detail: string): string {
  return detail.length <= POLICY_EVALUATE_DETAIL_MAX
    ? detail
    : `${detail.slice(0, POLICY_EVALUATE_DETAIL_MAX - 1)}…`;
}

/**
 * The slot for a signal no selected rule asked for.
 *
 * `not-requested` is an expected absence, so the engine never degrades the
 * report over it (§8.7) — it simply records why the signal is missing.
 */
function notRequestedSlot(signal: PolicySignal): PolicyUnavailableSlot {
  return {
    status: "unavailable",
    reason: "not-requested",
    detail: `${signal} was not gathered: no selected rule requires or enriches on it`,
  };
}

/**
 * Normalises the `--rule` selection into registry declaration order.
 *
 * Filtering the declaration-ordered tuple deduplicates and orders in one step,
 * so a repeated or out-of-order `--rule` cannot change the gather plan.
 *
 * @param rules - Selected rule ids, or undefined for "every registered rule".
 * @returns The selection, deduplicated, in declaration order.
 */
function selectRules(rules: readonly PolicyRuleId[] | undefined): readonly PolicyRuleId[] {
  if (rules === undefined || rules.length === 0) {
    return POLICY_RULE_IDS;
  }
  return POLICY_RULE_IDS.filter((id) => rules.includes(id));
}

/**
 * The gather plan: `requires ∪ enriches` over the selection (§8.1 item 7).
 *
 * @param selected - The normalised rule selection.
 * @returns Exactly the signals this run is allowed to spend a round trip on.
 */
function buildGatherPlan(selected: readonly PolicyRuleId[]): ReadonlySet<PolicySignal> {
  return new Set<PolicySignal>([...requiredSignalsFor(selected), ...enrichedSignalsFor(selected)]);
}

/**
 * Resolves the Plex library the drains will scope to.
 *
 * The library must be known *before* any gather, but the `PolicyResolvedPolicy`
 * echoed in the report has to be resolved against the LIVE quality-profile slot,
 * which does not exist yet. Resolving twice through the same pure function is
 * cheap and keeps the default library literal owned solely by the engine (§5.2:
 * every default is applied at one consumption site).
 *
 * @param config - Raw `policy:` config, or undefined when unset.
 * @param overrides - Per-invocation CLI overrides.
 * @returns The Plex music library name or identifier to drain.
 */
function resolveGatherLibrary(
  config: ReturnType<typeof getLoadedPolicyConfig>,
  overrides: PolicyEvaluationOverrides,
): string {
  return resolvePolicyConfig(config, overrides, notRequestedSlot("lidarrQualityProfiles"))
    .plexLibrary;
}

/**
 * Builds the `bridgeIdentity` slot from the shipped reconciliation.
 *
 * `executeLidarrReconcile` throws on every failure mode it knows — missing
 * credentials, an unusable library selector, an invalid Plex page, a Lidarr
 * outage — and a policy report must be able to say "the identity bridge was
 * unreadable" rather than die, so every throw becomes a `data-unavailable` slot
 * exactly like the gatherers' failures.
 *
 * It is deliberately called OUTSIDE this action's scheduler task: it schedules
 * its own `local-only` unit of work, and acquiring a second slot in the same
 * lane from inside the first would deadlock whenever `lidarr.scheduler` narrows
 * that lane's concurrency to one.
 *
 * @param library - The resolved Plex music library.
 * @param options - Connection overrides and cancellation.
 * @param dependencies - Injected collaborators.
 * @returns The bridge slot; never throws for a reconciliation failure.
 */
async function gatherBridgeIdentity(
  library: string,
  options: LidarrPolicyEvaluateActionOptions,
  dependencies: LidarrPolicyEvaluateDependencies,
): Promise<PolicySignalBundle["bridgeIdentity"]> {
  try {
    logDebug(`lidarr policy: reconciling the Plex-Lidarr identity bridge for library "${library}"`);
    const reconciliation = await dependencies.executeReconcile({
      plexLibrary: library,
      plexUrl: options.plexUrl,
      plexToken: options.plexToken,
      lidarrUrl: options.lidarrUrl,
      lidarrApiKey: options.lidarrApiKey,
      signal: options.signal,
    });
    return { status: "available", data: reconciliation.report };
  } catch (error) {
    logDebug("lidarr policy: the Plex-Lidarr identity bridge is unavailable");
    return {
      status: "unavailable",
      reason: "data-unavailable",
      detail: boundedDetail(`Plex-Lidarr identity bridge unavailable: ${errorMessage(error)}`),
    };
  }
}

/**
 * Gathers exactly the planned signals, sequentially and deterministically.
 *
 * Sequential awaits keep a narrowed run from opening several concurrent library
 * walks against the same providers, and make the emitted debug order stable.
 *
 * @param plan - The `requires ∪ enriches` union for this run.
 * @param bridgeIdentity - The already-built bridge slot.
 * @param library - The resolved Plex music library.
 * @param options - Connection overrides.
 * @param dependencies - Injected collaborators.
 * @param signal - The scheduler task signal, checked by every gatherer.
 * @returns One slot per `PolicySignal`.
 */
async function gatherPlannedSignals(
  plan: ReadonlySet<PolicySignal>,
  bridgeIdentity: PolicySignalBundle["bridgeIdentity"],
  library: string,
  options: LidarrPolicyEvaluateActionOptions,
  dependencies: LidarrPolicyEvaluateDependencies,
  signal: AbortSignal | undefined,
): Promise<PolicySignalBundle> {
  const lidarrOptions = {
    lidarrUrl: options.lidarrUrl,
    lidarrApiKey: options.lidarrApiKey,
    signal,
  };
  const plexOptions = {
    library,
    plexUrl: options.plexUrl,
    plexToken: options.plexToken,
    signal,
  };

  const lidarrArtists = plan.has("lidarrArtists")
    ? await dependencies.gatherLidarrArtists(lidarrOptions)
    : notRequestedSlot("lidarrArtists");
  const lidarrQualityProfiles = plan.has("lidarrQualityProfiles")
    ? await dependencies.gatherLidarrQualityProfiles(lidarrOptions)
    : notRequestedSlot("lidarrQualityProfiles");
  const plexArtistRatings = plan.has("plexArtistRatings")
    ? await dependencies.gatherPlexArtistRatings(plexOptions)
    : notRequestedSlot("plexArtistRatings");
  const plexTrackPlays = plan.has("plexTrackPlays")
    ? await dependencies.gatherPlexTrackPlays(plexOptions)
    : notRequestedSlot("plexTrackPlays");

  return {
    bridgeIdentity,
    lidarrArtists,
    lidarrQualityProfiles,
    plexArtistRatings,
    plexTrackPlays,
  };
}

/**
 * Reads the credential-free origins out of the reconciliation scope.
 *
 * @param bridgeIdentity - The gathered bridge slot.
 * @returns The canonical origins, or `unknown` when the bridge is unavailable.
 */
function resolveOrigins(bridgeIdentity: PolicySignalBundle["bridgeIdentity"]): {
  readonly plexOrigin: string;
  readonly lidarrOrigin: string;
} {
  if (bridgeIdentity.status !== "available") {
    return { plexOrigin: UNKNOWN_ORIGIN, lidarrOrigin: UNKNOWN_ORIGIN };
  }
  return {
    plexOrigin: bridgeIdentity.data.scope.plexOrigin,
    lidarrOrigin: bridgeIdentity.data.scope.lidarrOrigin,
  };
}

/* ── Entrypoint ──────────────────────────────────────────────────────────── */

/**
 * Executes one cancellable, strictly read-only consumption-policy evaluation.
 *
 * Writes nothing to Plex, to Lidarr, to the plan directory, or to stdout, and
 * never sets `process.exitCode` — the command owns rendering and the exit gate
 * (`shouldFailPolicyEvaluation`).
 *
 * @param options - Library scope, rule selection, caps, and connection overrides.
 * @param dependencies - Injected collaborators; defaults to the real ones.
 * @returns The frozen report plus this lane's execution metadata.
 * @throws Whatever the scheduler surfaces for a cancelled or budget-exhausted
 *   lane; a failed *signal* never throws, it becomes an unavailable slot.
 */
export async function executeLidarrPolicyEvaluate(
  options: LidarrPolicyEvaluateActionOptions,
  dependencies: LidarrPolicyEvaluateDependencies = DEFAULT_DEPENDENCIES,
): Promise<LidarrPolicyEvaluateActionResult> {
  options.signal?.throwIfAborted();

  const selected = selectRules(options.rules);
  const plan = buildGatherPlan(selected);
  const config = dependencies.loadedPolicyConfig();
  const overrides: PolicyEvaluationOverrides = {
    plexLibrary: options.plexLibrary,
    maxProposals: options.maxProposals,
    ratingMinRating: options.ratingMinRating,
    ratingTargetQualityProfile: options.ratingTargetQualityProfile,
    staleMaxPlays: options.staleMaxPlays,
    forceEnable: options.forceEnableRules,
  };
  const library = resolveGatherLibrary(config, overrides);
  logDebug(`lidarr policy: gather plan for ${selected.join(", ")} → ${[...plan].join(", ")}`);

  const bridgeIdentity = plan.has("bridgeIdentity")
    ? await gatherBridgeIdentity(library, options, dependencies)
    : notRequestedSlot("bridgeIdentity");
  const origins = resolveOrigins(bridgeIdentity);
  options.signal?.throwIfAborted();

  const scheduled = await dependencies.resolveScheduler().runSingle(
    TIER,
    {
      id: TASK_ID,
      operation: OPERATION,
      idempotent: true,
      run: async ({ signal }): Promise<PolicyEvaluationReport> => {
        const signals = await gatherPlannedSignals(
          plan,
          bridgeIdentity,
          library,
          options,
          dependencies,
          signal,
        );
        signal?.throwIfAborted();
        return dependencies.runEvaluation({
          evaluatedAt: dependencies.now().toISOString(),
          plexOrigin: origins.plexOrigin,
          lidarrOrigin: origins.lidarrOrigin,
          selected: new Set(selected),
          signals,
          config,
          overrides,
        });
      },
    },
    options.signal === undefined ? undefined : { signal: options.signal },
  );

  return Object.freeze({
    report: scheduled.value,
    execution: Object.freeze({ ...scheduled.execution }),
  });
}
