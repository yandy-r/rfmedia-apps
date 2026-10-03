/**
 * Batch readiness gate for staged rollouts.
 *
 * `waitForBatchReady` polls one rollout batch until every member is ready, one
 * member fails terminally, or the time/attempt bound is exhausted. Each attempt
 * costs three Docker calls regardless of batch size: one `docker compose ps`,
 * one service-to-container map, and one batched `docker inspect`.
 *
 * Evidence and classification notes:
 *
 * 1. **Degraded telemetry never masks a real failure.** `state` is sourced from
 *    `getServiceStatusMap` independently of `inspectContainers`, and
 *    `classifyTargetObservation` tests `state === "exited"` before it tests
 *    `imageId === undefined`, so a missing inspect result downgrades a verdict to
 *    `pending`/`telemetry-unavailable` but can never turn a crashed container into
 *    a passing one.
 * 2. **Known limitation: a failed `docker compose ps` does NOT set `degraded`.**
 *    `getServiceStatusMap` logs the error and returns every service defaulted to
 *    `{ state: "created", health: "none" }`, and `ReadinessSignalType` has no
 *    member for that signal. Every batch member then classifies
 *    `pending`/`not-running`, so a transient Docker daemon hiccup burns the full
 *    gate bound and halts the rollout instead of being reported as degraded
 *    telemetry. Only the service-container map and container inspect signals feed
 *    `signalAvailability`.
 * 3. **`waitForBatchReady` throws on an empty `services` array.**
 *    `resolveTargetServices` returns every service in the compose file for an
 *    empty request, so any future reordering that let a gate run on an empty set
 *    would silently turn a batch gate into a whole-compose-file poll. The empty
 *    batch is rejected at the boundary instead.
 */

import { logDebug } from "@rfmedia/common";

import type {
  ReadinessPollSettings,
  ReadinessSignalAvailability,
  ReadinessSignalType,
  TargetServiceObservation,
} from "../types/health.js";
import type {
  StagedExecutionContext,
  StagedGateReport,
  StagedServiceVerdict,
} from "../types/staged.js";

import { getComposeContainerObservations, inspectContainers } from "./docker.js";
import type { ComposeContainerObservation, ContainerInspect } from "./docker.js";
import {
  canAccumulateStableRunning,
  classifyTargetObservation,
  normalizeTargetState,
} from "./health.js";
import { getServiceStatusMap } from "./service-status.js";

/**
 * Soak window a healthcheck-less batch member must stay running before it is
 * considered ready. Matches the `stableRunningSeconds` default used by
 * `verifyServiceReadiness`; deliberately not exposed as a flag.
 */
const STABLE_RUNNING_MS = 5000;

/** Timeout applied to every Docker call made by the default batch observer. */
const OBSERVE_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Batch-gate observation. Superset of {@link TargetServiceObservation} with the
 * container restart policy, needed to exempt completed one-shot jobs.
 *
 * `restartPolicy` mirrors `ContainerInspect.HostConfig.RestartPolicy.Name`.
 * Docker emits `""`, `"no"`, `"always"`, `"unless-stopped"`, or `"on-failure"`.
 * `TargetServiceObservation` is deliberately NOT widened -- managed-update and
 * reconcile depend on its current shape.
 */
export interface StagedServiceObservation extends TargetServiceObservation {
  /** Configured Docker restart policy name, when inspect telemetry is available. */
  restartPolicy?: string;
}

/** One observation frame covering every member of a batch. */
export interface StagedBatchObservation {
  /** Per-service observation, keyed by Compose service name. */
  services: Map<string, StagedServiceObservation>;
  /** Which readiness signals were available while building this frame. */
  signalAvailability: ReadinessSignalAvailability;
}

/** Produces one observation frame for the requested services. */
export type StagedBatchObserver = (services: string[]) => Promise<StagedBatchObservation>;

/**
 * Resolve Compose service names to container names, stopped containers included.
 *
 * Deliberately NOT `getRunningServiceContainerMap`: that map comes from
 * `docker compose ps --status running`, so a one-shot job that has already
 * exited owns no entry, no container name reaches `inspectContainers`, and the
 * `ExitCode`/`RestartPolicy` telemetry that {@link isCompletedOneShot} requires
 * is never observed. `getComposeContainerObservations` is the project's existing
 * `ps --all` primitive (also used by drift and state-rebuild) and it throws
 * rather than returning `undefined`, so the failure is translated here into the
 * `service-container-map` degraded signal the gate already reports.
 *
 * When a service owns several containers the running one wins, so a batch member
 * that is actually up is never judged on a leftover container's telemetry.
 *
 * @param ctx - Compose file, project directory, profiles, and exec options
 * @returns Map from Compose service name to container name, or undefined when the listing failed
 */
async function observeServiceContainerNames(
  ctx: StagedExecutionContext,
): Promise<Map<string, string> | undefined> {
  let observations: readonly ComposeContainerObservation[];
  try {
    observations = await getComposeContainerObservations(ctx.composePath, {
      ...ctx.exec,
      profiles: ctx.profiles,
      timeout: OBSERVE_TIMEOUT_MS,
    });
  } catch (error) {
    logDebug(
      `Batch observer could not list Compose containers: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }

  const isRunning = (observation: ComposeContainerObservation): boolean =>
    observation.state.toLowerCase() === "running";

  const preferred = new Map<string, ComposeContainerObservation>();
  for (const observation of observations) {
    const current = preferred.get(observation.serviceName);
    if (current === undefined || (isRunning(observation) && !isRunning(current))) {
      preferred.set(observation.serviceName, observation);
    }
  }

  return new Map(
    [...preferred].map(([service, observation]) => [service, observation.containerName]),
  );
}

/**
 * Build the default batched observer for a staged rollout.
 *
 * Costs three Docker calls per invocation regardless of batch size: two
 * `docker compose ps -a` reads (one for state and health, scoped by
 * `preloadedServices` so no extra `getComposeServices` call is made; one for
 * service-to-container names) and one batched `docker inspect` over the resolved
 * container names. The inspect call is skipped entirely when no batch member has
 * a container.
 *
 * @param ctx - Compose file, project directory, profiles, and exec options
 * @returns An observer bound to `ctx`
 */
export function createBatchObserver(ctx: StagedExecutionContext): StagedBatchObserver {
  return async (services: string[]): Promise<StagedBatchObservation> => {
    const unavailableSignals: ReadinessSignalType[] = [];

    const [statusMap, containerMap] = await Promise.all([
      getServiceStatusMap(ctx.composePath, ctx.projectDir, {
        ...ctx.exec,
        profiles: ctx.profiles,
        preloadedServices: [...services],
        cacheTtlMs: 0,
        forceRefresh: true,
        timeoutMs: OBSERVE_TIMEOUT_MS,
      }),
      observeServiceContainerNames(ctx),
    ]);

    if (containerMap === undefined) {
      unavailableSignals.push("service-container-map");
    }

    const containerNames = services
      .map((service) => containerMap?.get(service))
      .filter((name): name is string => name !== undefined);

    let inspectedByName = new Map<string, ContainerInspect>();
    if (containerNames.length > 0) {
      const inspected = await inspectContainers(containerNames, {
        ...ctx.exec,
        timeout: OBSERVE_TIMEOUT_MS,
      });
      if (inspected === undefined) {
        unavailableSignals.push("container-inspect");
      } else {
        inspectedByName = new Map<string, ContainerInspect>(
          inspected.map((container) => [container.Name.replace(/^\//, ""), container]),
        );
      }
    }

    const observed = new Map<string, StagedServiceObservation>();
    for (const service of services) {
      const status = statusMap.get(service);
      const containerName = containerMap?.get(service);
      const container =
        containerName === undefined ? undefined : inspectedByName.get(containerName);
      observed.set(service, {
        imageId: container?.Image,
        state: normalizeTargetState(status?.state),
        exitCode: container?.State.ExitCode,
        health: status?.health ?? "unknown",
        restartPolicy: container?.HostConfig.RestartPolicy?.Name,
      });
    }

    return {
      services: observed,
      signalAvailability: {
        available: unavailableSignals.length === 0,
        unavailableSignals,
      },
    };
  };
}

/**
 * True for a container that ran to completion by design.
 *
 * Required, not defensive: `compose.yml` defines `plex-ratings-sync` with
 * `command: sync`, `restart: on-failure:10` and no healthcheck, driven by an
 * Ofelia schedule label, and it is a member of `media-stack`. Once its sync job
 * finishes it sits at exited(0) and `classifyTargetObservation` would return
 * `{ status: "failed", reason: "exited" }`.
 *
 * A container with an always-restart policy that is `exited` is genuinely broken
 * and must still fail the gate.
 *
 * @param observation - Latest observation for one batch member
 * @returns True when the container exited successfully under a non-restarting policy
 */
export function isCompletedOneShot(observation: StagedServiceObservation): boolean {
  if (observation.state !== "exited" || observation.exitCode !== 0) {
    return false;
  }
  const policy = observation.restartPolicy ?? "";
  return policy === "" || policy === "no" || policy === "on-failure";
}

/** Inputs for one batch gate. */
export interface WaitForBatchReadyOptions {
  /** The batch's own started services. MUST be non-empty (empty-batch guard throws). */
  services: string[];
  /** Time, interval, and attempt bounds for the gate */
  poll: ReadinessPollSettings;
  /** `false` collapses `maxAttempts` to 1 (snapshot mode) */
  waitForReady: boolean;
  /** Called with the still-pending members whenever that set changes */
  onProgress?: (pending: string[]) => void;
}

/** Injectable boundaries for {@link waitForBatchReady}. */
export interface WaitForBatchReadyDeps {
  /** Clock read; defaults to `Date.now` */
  now: () => number;
  /** Poll delay; defaults to a `setTimeout` promise */
  sleep: (ms: number) => Promise<void>;
  /** Observation source; required, there is no sensible default without a context */
  observe: StagedBatchObserver;
}

function evaluateService(
  service: string,
  observation: StagedServiceObservation | undefined,
  observedAt: number,
  stableSince: Map<string, number>,
): StagedServiceVerdict {
  const observed: StagedServiceObservation = observation ?? { state: "missing", health: "unknown" };

  if (canAccumulateStableRunning(observed, undefined)) {
    if (!stableSince.has(service)) {
      stableSince.set(service, observedAt);
    }
  } else {
    stableSince.delete(service);
  }
  const since = stableSince.get(service);
  const stableForMs = since === undefined ? 0 : observedAt - since;

  if (isCompletedOneShot(observed)) {
    return {
      service,
      status: "ready",
      reason: "completed",
      assurance: "running-only",
      stableForMs: 0,
    };
  }

  // The batch gate has no reviewed image to assert against, so the observed image
  // is its own expectation. `imageId === undefined` is classified as
  // `telemetry-unavailable` before the match is ever tested.
  const target = classifyTargetObservation(
    observed,
    observed.imageId ?? "",
    stableForMs,
    STABLE_RUNNING_MS,
  );

  return {
    service,
    status: target.status,
    reason: target.reason,
    assurance: target.assurance,
    stableForMs: target.stableForMs,
  };
}

/**
 * Gate one rollout batch on the readiness of its own started services.
 *
 * Returns as soon as every member is ready, as soon as any member reaches a
 * terminal `failed` verdict, or once the time or attempt bound is exhausted. The
 * terminal-failure short-circuit is load-bearing, not an optimisation: it keeps a
 * crashed canary from burning the whole `--health-timeout` while the deploy holds
 * the state lock, and it is what distinguishes `gate-unready`
 * (`ready: false, timedOut: false`) from `gate-timeout`
 * (`ready: false, timedOut: true`) for the caller.
 *
 * @param options - Batch members, poll bounds, wait mode, and progress callback
 * @param injected - Observation source plus optional clock and sleep overrides
 * @returns Aggregate gate report with one verdict per gated service
 * @throws Error when `options.services` is empty
 */
export async function waitForBatchReady(
  options: WaitForBatchReadyOptions,
  injected: Partial<WaitForBatchReadyDeps> & Pick<WaitForBatchReadyDeps, "observe">,
): Promise<StagedGateReport> {
  if (options.services.length === 0) {
    throw new Error("waitForBatchReady requires at least one service to gate");
  }

  const now = injected.now ?? Date.now;
  const pollSleep = injected.sleep ?? sleep;
  const observe = injected.observe;

  const timeoutMs = options.poll.timeoutSeconds * 1000;
  const intervalMs = options.poll.intervalSeconds * 1000;
  const maxAttempts = options.waitForReady ? Math.max(1, options.poll.retries) : 1;
  const startedAt = now();
  const stableSince = new Map<string, number>();
  let previousPendingSignature = "";

  for (let attempt = 1; ; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const observation = await observe(options.services);
    const observedAt = now();

    const verdicts = options.services.map((service) =>
      evaluateService(service, observation.services.get(service), observedAt, stableSince),
    );

    const ready = verdicts.every((verdict) => verdict.status === "ready");
    const anyFailed = verdicts.some((verdict) => verdict.status === "failed");
    const degraded = !observation.signalAvailability.available;
    const elapsedMs = observedAt - startedAt;
    const timedOut = !ready && !anyFailed && (elapsedMs >= timeoutMs || attempt >= maxAttempts);

    if (options.onProgress !== undefined) {
      const pending = verdicts
        .filter((verdict) => verdict.status !== "ready")
        .map((verdict) => verdict.service);
      const signature = pending.join(",");
      if (pending.length > 0 && signature !== previousPendingSignature) {
        previousPendingSignature = signature;
        options.onProgress(pending);
      }
    }

    if (ready || anyFailed || timedOut) {
      return { ready, timedOut, degraded, elapsedMs, attempts: attempt, services: verdicts };
    }

    logDebug(
      `Batch gate pending (attempt ${attempt}/${maxAttempts}, elapsed ${elapsedMs}ms): ` +
        verdicts
          .filter((verdict) => verdict.status !== "ready")
          .map((verdict) => `${verdict.service}=${verdict.reason}`)
          .join(", "),
    );
    // eslint-disable-next-line no-await-in-loop
    await pollSleep(intervalMs);
  }
}
