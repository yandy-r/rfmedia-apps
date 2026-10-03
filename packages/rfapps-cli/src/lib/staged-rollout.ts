/**
 * Staged rollout coordinator: batch planning, batch execution, and rendering.
 *
 * A staged rollout splits a dependency-phased execution plan into blast-radius
 * ordered batches, starts one batch at a time, and gates each batch on container
 * readiness before starting the next one. The same coordinator drives the
 * non-staged parallel path, which runs as a single batch with no gate, so both
 * paths share one failure-accounting implementation.
 *
 * Ordering rules, least critical first:
 * 1. `core`-profile services sort last within their phase (criticality tier).
 * 2. Then ascending dependency fan-in (how many services depend on it).
 * 3. Then service name, for a deterministic plan.
 *
 * Batches may span a phase boundary. Each batch therefore carries a phase slice
 * that preserves the source phase numbers and `dependsOn` lists, so
 * `executeParallelPhases` still starts a database before the service that
 * depends on it even when both land in the same batch.
 *
 * This module performs no I/O: Docker work and readiness gating are injected as
 * dependencies, and nothing here writes to the logger or `process.exitCode`.
 */

import { invertDependencyMap } from "./dependency-graph.js";
import { filterByDependencyFailures } from "./parallel-executor.js";
import { STATE_LOCK_STALE_AFTER_MS } from "./state-lock.js";

import type { DependencyGraph, ExecutionPhase } from "../types/parallel.js";
import type { FailedOperation } from "../types/results.js";
import type {
  StagedBatch,
  StagedBatchFailed,
  StagedBatchFailureCause,
  StagedBatchOutcome,
  StagedFailurePolicy,
  StagedGateReport,
  StagedPlan,
  StagedRolloutEvent,
  StagedRolloutReport,
  StagedRolloutSummary,
} from "../types/staged.js";

/** `FailedOperation.code` for a service whose dependency failed in an earlier batch. */
const STAGE_DEPENDENCY_SKIPPED = "STAGE_DEPENDENCY_SKIPPED";

/** `FailedOperation.code` for a started service that never satisfied its batch gate. */
const STAGE_GATE_FAILED = "STAGE_GATE_FAILED";

/** `FailedOperation.code` for a service in a batch the rollout never reached. */
const STAGE_NOT_ATTEMPTED = "STAGE_NOT_ATTEMPTED";

/** Criticality tier for a service; `core` services roll out last within a phase. */
function criticalityTier(
  service: string,
  profileMapping: Readonly<Record<string, string>>,
): number {
  return profileMapping[service] === "core" ? 1 : 0;
}

/** Reverse the dependency map into a per-service count of dependents. */
function computeFanIn(
  dependencyMap: Map<string, string[]> | undefined,
): ReadonlyMap<string, number> {
  const fanIn = new Map<string, number>();
  if (dependencyMap === undefined) {
    return fanIn;
  }
  for (const [service, dependents] of invertDependencyMap(dependencyMap)) {
    fanIn.set(service, dependents.length);
  }
  return fanIn;
}

/** Compare two services by `[criticality tier, fan-in, name]`, ascending. */
function compareBlastRadius(
  a: string,
  b: string,
  fanIn: ReadonlyMap<string, number>,
  profileMapping: Readonly<Record<string, string>>,
): number {
  const tierDelta = criticalityTier(a, profileMapping) - criticalityTier(b, profileMapping);
  if (tierDelta !== 0) {
    return tierDelta;
  }
  const fanInDelta = (fanIn.get(a) ?? 0) - (fanIn.get(b) ?? 0);
  if (fanInDelta !== 0) {
    return fanInDelta;
  }
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * Restrict phases to `members`, preserving phase numbers, `dependsOn`, and the
 * source order of each phase's services. Emptied phases are dropped.
 *
 * With a batch that holds every service, this reproduces the source phases
 * exactly, which is what keeps the non-staged path byte-identical.
 */
function sliceToServices(
  phases: readonly ExecutionPhase[],
  members: readonly string[],
): ExecutionPhase[] {
  const wanted = new Set(members);
  const sliced: ExecutionPhase[] = [];
  for (const phase of phases) {
    const services = phase.services.filter((service) => wanted.has(service));
    if (services.length === 0) {
      continue;
    }
    sliced.push({ phase: phase.phase, services, dependsOn: [...phase.dependsOn] });
  }
  return sliced;
}

/**
 * Split a dependency graph into blast-radius ordered rollout batches.
 *
 * Pure: no Docker, no I/O, no logging. A missing `graph.dependencyMap` degrades
 * to `[criticality tier, name]` ordering rather than failing, because
 * `computeExecutionPhases` legitimately falls back to a single phase when the
 * compose config cannot be read.
 *
 * @param input - Graph, batch size, failure policy, and the service-to-profile mapping
 * @returns The batched rollout plan
 * @throws When `batchSize` is not a positive integer
 */
export function planStagedBatches(input: {
  graph: DependencyGraph;
  batchSize: number;
  onFailure: StagedFailurePolicy;
  /** `RfappsConfig.profiles.mapping` — service to profile name */
  profileMapping: Readonly<Record<string, string>>;
}): StagedPlan {
  const { graph, batchSize, onFailure, profileMapping } = input;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`Staged batch size must be a positive integer, received: ${batchSize}`);
  }

  const fanIn = computeFanIn(graph.dependencyMap);
  const ordered: string[] = [];
  for (const phase of graph.phases) {
    const phaseOrder = [...phase.services].sort((a, b) =>
      compareBlastRadius(a, b, fanIn, profileMapping),
    );
    ordered.push(...phaseOrder);
  }

  const batches: StagedBatch[] = [];
  for (let offset = 0; offset < ordered.length; offset += batchSize) {
    const services = ordered.slice(offset, offset + batchSize);
    batches.push({
      index: batches.length + 1,
      services,
      phases: sliceToServices(graph.phases, services),
    });
  }

  return { batches, batchSize, onFailure, totalServices: ordered.length };
}

/** Compose operation a batch issues through the injected runner. */
export type StagedPhaseOperation = "pull" | "start";

/** Outcome of one injected Compose phase run. */
export interface StagedRunPhaseResult {
  /** Services whose operation succeeded */
  succeeded: string[];
  /** Services whose operation failed, with error details */
  failed: FailedOperation[];
}

/** Inputs for {@link executeStagedRollout}. */
export interface ExecuteStagedRolloutOptions {
  /** Batched rollout plan from {@link planStagedBatches} */
  plan: StagedPlan;
  /** `graph.dependencyMap`; undefined degrades to the phase-level `dependsOn` rule */
  dependencyMap?: Map<string, string[]>;
  /** Skip the per-batch image pull */
  skipPull: boolean;
  /** Progress sink; undefined suppresses all rollout chatter */
  onEvent?: (event: StagedRolloutEvent) => void;
}

/** Injected boundaries for {@link executeStagedRollout}. */
export interface ExecuteStagedRolloutDeps {
  /** Runs one Compose operation for a batch */
  runPhase: (input: {
    operation: StagedPhaseOperation;
    batch: StagedBatch;
    /** `batch.phases` re-sliced to the executable members only */
    phases: ExecutionPhase[];
  }) => Promise<StagedRunPhaseResult>;
  /** Per-batch readiness gate; undefined disables gating (--no-wait-for-ready or non-staged) */
  gate?: (input: {
    batch: StagedBatch;
    started: string[];
    onProgress: (pending: string[]) => void;
  }) => Promise<StagedGateReport>;
}

/** Mutable accounting carried across batches. */
interface RolloutState {
  /**
   * Services that failed anywhere in the rollout. Owned here because
   * `executeParallelPhases` resets its own failure set on every call, so
   * cross-batch dependency skipping would otherwise be lost.
   */
  rolloutFailed: Set<string>;
  /** Services a start was ISSUED for: succeeded union failed */
  attempted: string[];
  /** Services that started successfully, in rollout order */
  started: string[];
}

/** Everything one batch execution needs. */
interface BatchRunContext {
  options: ExecuteStagedRolloutOptions;
  deps: ExecuteStagedRolloutDeps;
  state: RolloutState;
  emit: (event: StagedRolloutEvent) => void;
}

/** Partition a batch's phases into executable and dependency-skipped members. */
function partitionBatch(
  batch: StagedBatch,
  context: BatchRunContext,
): { executable: string[]; skipped: string[] } {
  const executable: string[] = [];
  const skipped: string[] = [];
  for (const phase of batch.phases) {
    const filtered = filterByDependencyFailures(
      phase,
      context.state.rolloutFailed,
      context.options.dependencyMap,
    );
    executable.push(...filtered.executable);
    skipped.push(...filtered.skipped);
  }
  return { executable, skipped };
}

/** A batch outcome produced by an attempted batch; `skipped` is decided by the caller. */
type StagedBatchPassedOrFailed = Extract<StagedBatchOutcome, { status: "passed" | "failed" }>;

/**
 * Members the injected runner reported as failed without ever issuing a start.
 *
 * `executeParallelPhases` applies `filterByDependencyFailures` per phase and
 * reports the services it skipped in the same `failed` array as genuine start
 * failures, with no distinguishing code. Replaying the identical filter over the
 * same phases and dependency map recovers the split, which keeps `attempted` --
 * and therefore the caller's `up -d --remove-orphans` scope -- limited to
 * services a start was actually ISSUED for.
 */
function deriveNotIssued(
  phases: readonly ExecutionPhase[],
  failed: readonly FailedOperation[],
  dependencyMap: Map<string, string[]> | undefined,
): Set<string> {
  const failedNames = new Set(failed.map((failure) => failure.name));
  const runnerFailed = new Set<string>();
  const notIssued = new Set<string>();
  for (const phase of phases) {
    const filtered = filterByDependencyFailures(phase, runnerFailed, dependencyMap);
    for (const service of filtered.skipped) {
      notIssued.add(service);
      runnerFailed.add(service);
    }
    for (const service of filtered.executable) {
      if (failedNames.has(service)) {
        runnerFailed.add(service);
      }
    }
  }
  return notIssued;
}

/** Run one batch: pull, start, gate, and classify. Never throws for Docker failures. */
async function executeBatch(
  batch: StagedBatch,
  context: BatchRunContext,
): Promise<StagedBatchPassedOrFailed> {
  const { options, deps, state, emit } = context;
  const batchFailed: FailedOperation[] = [];

  const { executable, skipped } = partitionBatch(batch, context);
  for (const service of skipped) {
    state.rolloutFailed.add(service);
    batchFailed.push({
      name: service,
      code: STAGE_DEPENDENCY_SKIPPED,
      error: "Skipped: dependency failed in an earlier batch",
    });
  }

  if (executable.length === 0) {
    // No Docker call at all: every member is blocked by an earlier failure.
    return {
      batch,
      status: "failed",
      started: [],
      failed: batchFailed,
      unhealthy: [],
      cause: "dependency-skipped",
    };
  }

  const phases = sliceToServices(batch.phases, executable);

  if (!options.skipPull) {
    const pull = await deps.runPhase({ operation: "pull", batch, phases });
    // Pull failures never set a batch `cause`, but must still reach DeployResult.failed.
    batchFailed.push(...pull.failed);
  }

  const start = await deps.runPhase({ operation: "start", batch, phases });
  const started = start.succeeded;
  const notIssued = deriveNotIssued(phases, start.failed, options.dependencyMap);
  state.attempted.push(
    ...started,
    ...start.failed.map((failure) => failure.name).filter((service) => !notIssued.has(service)),
  );
  state.started.push(...started);
  for (const failure of start.failed) {
    state.rolloutFailed.add(failure.name);
    if (!batchFailed.some((entry) => entry.name === failure.name)) {
      batchFailed.push(failure);
    }
  }

  if (started.length === 0) {
    // Empty-batch guard: gating an empty set would poll the whole compose file.
    return {
      batch,
      status: "failed",
      started: [],
      failed: batchFailed,
      unhealthy: [],
      cause: "start-failed",
    };
  }

  const gateReport = deps.gate
    ? await deps.gate({
        batch,
        started,
        onProgress: (pending) => {
          emit({ kind: "gate-progress", batch, pending });
        },
      })
    : undefined;

  if (gateReport?.degraded === true) {
    emit({ kind: "gate-degraded", batch });
  }

  return classifyBatch({
    batch,
    started,
    batchFailed,
    startFailures: start.failed,
    gateReport,
    state,
  });
}

/**
 * Turn start results and gate evidence into a batch outcome.
 *
 * Degraded telemetry never halts, but the bypass is NARROW: it applies only when
 * every non-ready verdict is itself attributable to the missing signal
 * (`pending`/`telemetry-unavailable`). A transient `docker inspect` hiccup must
 * not abandon a rollout half-deployed, yet a service classified `failed`, or one
 * that is genuinely not running for an unrelated reason, still fails the batch --
 * otherwise one unavailable signal would launder a real outage into a pass.
 */
function classifyBatch(input: {
  batch: StagedBatch;
  started: string[];
  batchFailed: FailedOperation[];
  startFailures: FailedOperation[];
  gateReport: StagedGateReport | undefined;
  state: RolloutState;
}): StagedBatchPassedOrFailed {
  const { batch, started, batchFailed, startFailures, gateReport, state } = input;

  const degradedBypass =
    gateReport !== undefined &&
    gateReport.degraded &&
    gateReport.services.every(
      (verdict) =>
        verdict.status === "ready" ||
        (verdict.status === "pending" && verdict.reason === "telemetry-unavailable"),
    );
  const passes = gateReport === undefined || gateReport.ready || degradedBypass;

  // ALWAYS [] when no gate ran, otherwise every started service would count as
  // unhealthy on the non-staged path and empty DeployResult.healthy.
  const unhealthy =
    gateReport === undefined
      ? []
      : started.filter(
          (service) =>
            gateReport.services.find((verdict) => verdict.service === service)?.status !== "ready",
        );

  if (passes && startFailures.length === 0) {
    return {
      batch,
      status: "passed",
      started,
      failed: batchFailed,
      ...(gateReport === undefined ? {} : { gate: gateReport }),
    };
  }

  const cause: StagedBatchFailureCause =
    startFailures.length > 0
      ? "start-failed"
      : gateReport?.timedOut === true
        ? "gate-timeout"
        : "gate-unready";

  for (const service of unhealthy) {
    state.rolloutFailed.add(service);
    if (batchFailed.some((entry) => entry.name === service)) {
      continue;
    }
    const reason =
      gateReport?.services.find((verdict) => verdict.service === service)?.reason ?? "unknown";
    // The cause is embedded here because machine output carries no per-batch cause.
    batchFailed.push({
      name: service,
      code: STAGE_GATE_FAILED,
      error: `Batch ${batch.index} failed (${cause}): ${reason}`,
    });
  }

  return {
    batch,
    status: "failed",
    started,
    failed: batchFailed,
    unhealthy,
    cause,
    ...(gateReport === undefined ? {} : { gate: gateReport }),
  };
}

/** Project batch outcomes into the rollout report. */
function buildRolloutReport(
  plan: StagedPlan,
  outcomes: StagedBatchOutcome[],
  state: RolloutState,
  halt: { atBatch: number } | undefined,
): StagedRolloutReport {
  const totalBatches = plan.batches.length;
  const failedOutcomes = outcomes.filter(
    (outcome): outcome is StagedBatchFailed => outcome.status === "failed",
  );
  const unhealthy = failedOutcomes.flatMap((outcome) => outcome.unhealthy);

  const haltedAtBatch = halt?.atBatch;
  const notAttempted: FailedOperation[] =
    haltedAtBatch === undefined
      ? []
      : outcomes
          .filter((outcome) => outcome.status === "skipped")
          .flatMap((outcome) =>
            outcome.batch.services.map((name) => ({
              name,
              code: STAGE_NOT_ATTEMPTED,
              error: `Not attempted: staged rollout halted after batch ${haltedAtBatch} of ${totalBatches}`,
            })),
          );

  return {
    status: halt !== undefined ? "halted" : failedOutcomes.length > 0 ? "degraded" : "completed",
    batchSize: plan.batchSize,
    onFailure: plan.onFailure,
    totalBatches,
    completedBatches: outcomes.filter((outcome) => outcome.status === "passed").length,
    ...(haltedAtBatch === undefined ? {} : { haltedAtBatch }),
    batches: outcomes,
    attempted: [...state.attempted],
    started: state.started.length,
    // Successfully started services minus unhealthy — NOT `attempted` minus
    // unhealthy. `attempted` deliberately includes services whose `up` failed
    // (it scopes the caller's orphan-cleanup pass), and counting those as
    // healthy would keep `hasDeploySuccess` true for a deploy where nothing
    // started, turning `--allow-partial` exit 1 into exit 3.
    healthy: state.started.filter((service) => !unhealthy.includes(service)),
    unhealthy,
    failed: [...outcomes.flatMap((outcome) => outcome.failed), ...notAttempted],
  };
}

/**
 * Execute a staged rollout batch by batch.
 *
 * Runs for both the staged and the non-staged parallel path; the non-staged path
 * is a single batch with `onFailure: "continue"` and no gate. Docker failures are
 * accumulated, never thrown, so the caller keeps its cleanup and state recording.
 *
 * On a halt, remaining batches are recorded as `skipped` with **zero** Docker
 * calls, and every member of a skipped batch contributes one `STAGE_NOT_ATTEMPTED`
 * failure so a halted rollout can never resolve to exit code 0.
 *
 * @param options - Plan, dependency map, pull policy, and progress sink
 * @param deps - Injected Compose runner and optional readiness gate
 * @returns Full rollout evidence for exit-code resolution and rendering
 */
export async function executeStagedRollout(
  options: ExecuteStagedRolloutOptions,
  deps: ExecuteStagedRolloutDeps,
): Promise<StagedRolloutReport> {
  const emit = (event: StagedRolloutEvent): void => {
    options.onEvent?.(event);
  };
  const totalBatches = options.plan.batches.length;
  const state: RolloutState = { rolloutFailed: new Set<string>(), attempted: [], started: [] };
  const context: BatchRunContext = { options, deps, state, emit };
  const outcomes: StagedBatchOutcome[] = [];
  let halt: { atBatch: number } | undefined;

  for (const batch of options.plan.batches) {
    if (halt !== undefined) {
      outcomes.push({ batch, status: "skipped", reason: "rollout-halted", failed: [] });
      continue;
    }

    emit({ kind: "batch-start", batch, totalBatches });
    const batchStartedAt = Date.now();
    const outcome = await executeBatch(batch, context);
    const elapsedMs = Date.now() - batchStartedAt;
    outcomes.push(outcome);

    if (outcome.status === "failed") {
      emit({
        kind: "batch-failed",
        batch,
        cause: outcome.cause,
        failed: outcome.failed.map((failure) => failure.name),
        unhealthy: outcome.unhealthy,
        elapsedMs,
      });
      if (options.plan.onFailure === "halt") {
        halt = { atBatch: batch.index };
      }
    } else {
      emit({ kind: "batch-passed", batch, started: outcome.started, elapsedMs });
    }
  }

  if (halt !== undefined) {
    emit({
      kind: "rollout-halted",
      haltedAtBatch: halt.atBatch,
      totalBatches,
      skipped: outcomes
        .filter((outcome) => outcome.status === "skipped")
        .flatMap((outcome) => outcome.batch.services),
    });
  }

  return buildRolloutReport(options.plan, outcomes, state, halt);
}

/**
 * Project a rollout report onto the compact summary embedded in `DeployResult`.
 *
 * @param report - Full rollout evidence
 * @returns Summary safe to serialize through the MCP output schema
 */
export function summarizeStagedRollout(report: StagedRolloutReport): StagedRolloutSummary {
  return {
    status: report.status,
    batchSize: report.batchSize,
    onFailure: report.onFailure,
    totalBatches: report.totalBatches,
    completedBatches: report.completedBatches,
    ...(report.haltedAtBatch === undefined ? {} : { haltedAtBatch: report.haltedAtBatch }),
  };
}

/** Render `Ns` or `NmNs` for a whole-second duration. */
function formatSeconds(totalSeconds: number): string {
  const whole = Math.round(totalSeconds);
  if (whole < 60) {
    return `${whole}s`;
  }
  return `${Math.floor(whole / 60)}m${whole % 60}s`;
}

/** `batch` / `batches`, matching the count. */
function pluralizeBatches(count: number): string {
  return count === 1 ? "batch" : "batches";
}

/** `phase N` for a single-phase batch, `phase N-M` when the batch spans phases. */
function formatPhaseLabel(phases: readonly ExecutionPhase[]): string {
  const first = phases.at(0)?.phase;
  const last = phases.at(-1)?.phase;
  if (first === undefined || last === undefined) {
    return "phase -";
  }
  return first === last ? `phase ${first}` : `phase ${first}-${last}`;
}

/**
 * Render the pre-flight staged plan block.
 *
 * The worst-case lock-hold line is omitted entirely when `perBatchGateSeconds`
 * is 0, which is the `--dry-run` and `--no-wait-for-ready` case; printing
 * "up to 0s holding the state lock" would be noise.
 *
 * @param plan - Batched rollout plan
 * @param options - Per-batch gate bound in seconds; 0 disables the worst-case line
 * @returns Multi-line block, newline-joined
 */
export function formatStagedPlan(
  plan: StagedPlan,
  options: { perBatchGateSeconds: number },
): string {
  const batchCount = plan.batches.length;
  const lines: string[] = [
    `Staged rollout: ${batchCount} ${pluralizeBatches(batchCount)} (batch size ${plan.batchSize}, on failure: ${plan.onFailure})`,
  ];

  if (options.perBatchGateSeconds > 0) {
    const worstCase = formatSeconds(batchCount * options.perBatchGateSeconds);
    lines.push(
      `Worst case ${batchCount} ${pluralizeBatches(batchCount)} x ${options.perBatchGateSeconds}s gate = up to ${worstCase} holding the state lock.`,
    );
  }

  const rows = plan.batches.map((batch) => ({
    label: batch.index === 1 ? `Batch ${batch.index} [canary]` : `Batch ${batch.index}`,
    phaseLabel: formatPhaseLabel(batch.phases),
    services: batch.services.join(", "),
  }));
  const labelWidth = rows.reduce((width, row) => Math.max(width, row.label.length), 0);
  const phaseWidth = rows.reduce((width, row) => Math.max(width, row.phaseLabel.length), 0);
  for (const row of rows) {
    lines.push(
      `  ${row.label.padEnd(labelWidth)}  ${row.phaseLabel.padEnd(phaseWidth)}  ${row.services}`,
    );
  }

  return lines.join("\n");
}

/**
 * True when the worst-case rollout outruns the state-lock staleness threshold,
 * so another operator's `force-unlock` could see a live rollout as stale.
 *
 * @param plan - Batched rollout plan
 * @param perBatchGateSeconds - Per-batch gate bound in seconds
 * @returns True when the worst case exceeds `STATE_LOCK_STALE_AFTER_MS`
 */
export function stagedExceedsLockStaleness(plan: StagedPlan, perBatchGateSeconds: number): boolean {
  return plan.batches.length * perBatchGateSeconds * 1000 > STATE_LOCK_STALE_AFTER_MS;
}

/** A rollout event rendered for the text logger. */
export interface StagedEventRender {
  /** Logger level the message belongs on */
  level: "info" | "warn";
  /** Rendered message */
  message: string;
}

/**
 * Render one rollout event for text output.
 *
 * @param event - Rollout progress event
 * @returns Logger level and message
 */
export function formatStagedEvent(event: StagedRolloutEvent): StagedEventRender {
  switch (event.kind) {
    case "batch-start":
      return {
        level: "info",
        message: `Batch ${event.batch.index}/${event.totalBatches}: starting ${event.batch.services.length} services (${event.batch.services.join(", ")})`,
      };
    case "gate-progress":
      return {
        level: "info",
        message: `Batch ${event.batch.index}: waiting on ${event.pending.length} services (${event.pending.join(", ")})`,
      };
    case "batch-passed":
      return {
        level: "info",
        message: `Batch ${event.batch.index}: OK, ${event.started.length} services ready in ${formatSeconds(event.elapsedMs / 1000)}`,
      };
    case "batch-failed": {
      // `failed` already carries a STAGE_GATE_FAILED entry for every unhealthy
      // service, so the two lists overlap and must be de-duplicated.
      const names = [...new Set([...event.unhealthy, ...event.failed])];
      return {
        level: "warn",
        message: `Batch ${event.batch.index}: FAILED (${event.cause}) after ${formatSeconds(event.elapsedMs / 1000)}: ${names.join(", ")}`,
      };
    }
    case "gate-degraded":
      return {
        level: "warn",
        message: `Batch ${event.batch.index}: readiness telemetry incomplete; continuing without halting`,
      };
    case "rollout-halted":
      return {
        level: "warn",
        message: `Staged rollout halted after batch ${event.haltedAtBatch} of ${event.totalBatches}; ${event.skipped.length} services not attempted`,
      };
  }
}

/** `  label<pad>count  (names)` with the count column aligned to `labelWidth`. */
function formatCountLine(label: string, names: readonly string[], labelWidth: number): string {
  const detail = names.length === 0 ? "" : `  (${names.join(", ")})`;
  return `  ${label.padEnd(labelWidth)}${names.length}${detail}`;
}

/** One rendered bucket of the rollout's outcome ledger. */
interface SummaryBucket {
  label: string;
  names: string[];
}

/**
 * Partition every service the rollout did not confirm healthy.
 *
 * Derived from the FULL failure ledger, not just `report.unhealthy`: a batch that
 * failed at `start-failed` produces no unhealthy services at all, and dropping
 * those names would tell the operator to resume a set that excludes exactly the
 * services that need attention. Buckets are disjoint -- a service carrying both a
 * pull failure and a gate failure is reported once, under the more specific
 * bucket.
 */
function partitionFailureLedger(report: StagedRolloutReport): {
  unhealthy: string[];
  failedToStart: string[];
  dependencySkipped: string[];
  notAttempted: string[];
} {
  const claimed = new Set<string>(report.unhealthy);
  const take = (predicate: (code: string | undefined) => boolean): string[] => {
    const names: string[] = [];
    for (const failure of report.failed) {
      if (claimed.has(failure.name) || !predicate(failure.code)) {
        continue;
      }
      claimed.add(failure.name);
      names.push(failure.name);
    }
    return names;
  };

  const notAttempted = take((code) => code === STAGE_NOT_ATTEMPTED);
  const dependencySkipped = take((code) => code === STAGE_DEPENDENCY_SKIPPED);
  const failedToStart = take(() => true);
  return { unhealthy: [...report.unhealthy], failedToStart, dependencySkipped, notAttempted };
}

/**
 * Render the terminal staged summary block for a rollout that did not complete.
 *
 * The `Resume:` line covers every service that is not confirmed healthy and
 * deliberately omits `--force-recreate`, so resuming does not widen the blast
 * radius beyond the services that still need deploying.
 *
 * @param report - Full rollout evidence
 * @returns Lines to log in order
 */
export function formatStagedSummary(report: StagedRolloutReport): string[] {
  const ledger = partitionFailureLedger(report);
  const buckets: SummaryBucket[] = [
    { label: "healthy:", names: [...report.healthy] },
    { label: "unhealthy:", names: ledger.unhealthy },
    { label: "failed to start:", names: ledger.failedToStart },
    { label: "dependency skipped:", names: ledger.dependencySkipped },
    { label: "not attempted:", names: ledger.notAttempted },
  ];
  // Healthy anchors the block even at zero; failure buckets only when populated.
  const rendered = buckets.filter((bucket, index) => index === 0 || bucket.names.length > 0);
  const labelWidth =
    rendered.reduce((width, bucket) => Math.max(width, bucket.label.length), 0) + 2;

  const lines: string[] = [
    report.haltedAtBatch === undefined
      ? `DEGRADED: ${report.totalBatches - report.completedBatches} of ${report.totalBatches} ${pluralizeBatches(report.totalBatches)} did not pass`
      : `HALTED after batch ${report.haltedAtBatch} of ${report.totalBatches}`,
    ...rendered.map((bucket) => formatCountLine(bucket.label, bucket.names, labelWidth)),
  ];

  if (ledger.notAttempted.length > 0) {
    lines.push("  Services that were not attempted are still running their previous containers.");
  }

  const resume = [
    ...ledger.unhealthy,
    ...ledger.failedToStart,
    ...ledger.dependencySkipped,
    ...ledger.notAttempted,
  ];
  // Never point at a not-attempted service: its logs belong to the container it
  // is still running, which says nothing about why the rollout stopped.
  const investigate = ledger.unhealthy.at(0) ?? ledger.failedToStart.at(0);
  if (investigate !== undefined || resume.length > 0) {
    lines.push("");
  }
  if (investigate !== undefined) {
    lines.push(`  ${"Investigate:".padEnd(14)}rfapps logs -s ${investigate}`);
  }
  if (resume.length > 0) {
    lines.push(
      `  ${"Resume:".padEnd(14)}rfapps deploy --services ${resume.join(",")} --staged --batch-size ${report.batchSize}`,
    );
  }

  return lines;
}
