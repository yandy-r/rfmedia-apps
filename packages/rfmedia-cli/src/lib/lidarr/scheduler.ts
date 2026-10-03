/**
 * Fault-isolated scheduling for Lidarr operations.
 *
 * The scheduler reuses the canonical {@link LidarrTier} identifiers as lane
 * names. Each lane owns an independent admission pool and per-batch operation
 * budget, so a slow metadata or discovery dependency cannot consume capacity
 * reserved for local-only work. Scheduled actions disable the resilience
 * decorator's inner retry loop; this module is their sole in-place retry owner.
 */

import pLimit from "p-limit";

import type {
  LidarrSchedulerConfigOptions,
  LidarrSchedulerLaneConfigOptions,
} from "../../types/config.js";
import type { LidarrCircuitBreaker } from "./circuit-breaker.js";
import type { LidarrClientApi } from "./client.js";
import { LidarrValidationError, type LidarrErrorCode } from "./errors.js";
import { ensureTierHealthy } from "./health.js";
import { LIDARR_TIER_DESCRIPTORS, type LidarrTier } from "./tiers.js";

const RETRY_BASE_DELAY_MS = 500;
const TIMEOUT_RETRY_BASE_DELAY_MS = 2_000;

/** Fully resolved scheduler policy for one execution lane. */
export interface LidarrLanePolicy {
  /** Maximum operations from this lane that may execute concurrently. */
  readonly concurrency: number;
  /** Maximum operations admitted from this lane in one batch. */
  readonly operationBudget: number;
  /** Additional attempts for retryable, idempotent work. */
  readonly retryAttempts: number;
  /** Maximum delay before an in-place retry. */
  readonly retryBackoffCapMs: number;
}

/** Exhaustive, deeply frozen scheduler policy keyed by lane. */
export type ResolvedLidarrSchedulerPolicy = Readonly<Record<LidarrTier, LidarrLanePolicy>>;

/** Safe built-in lane defaults. */
export const DEFAULT_LIDARR_SCHEDULER_POLICY: ResolvedLidarrSchedulerPolicy = Object.freeze({
  "local-only": Object.freeze({
    concurrency: 8,
    operationBudget: 1_000,
    retryAttempts: 1,
    retryBackoffCapMs: 15_000,
  }),
  "metadata-dependent": Object.freeze({
    concurrency: 2,
    operationBudget: 50,
    retryAttempts: 1,
    retryBackoffCapMs: 30_000,
  }),
  discovery: Object.freeze({
    concurrency: 4,
    operationBudget: 100,
    retryAttempts: 2,
    retryBackoffCapMs: 30_000,
  }),
  destructive: Object.freeze({
    concurrency: 1,
    operationBudget: 25,
    retryAttempts: 0,
    retryBackoffCapMs: 15_000,
  }),
});

/** Resolves optional config overrides into a deeply frozen lane policy. */
export function resolveLidarrSchedulerPolicy(
  config?: LidarrSchedulerConfigOptions,
): ResolvedLidarrSchedulerPolicy {
  const resolveLane = (
    lane: LidarrTier,
    overrides?: LidarrSchedulerLaneConfigOptions,
  ): LidarrLanePolicy => {
    const defaults = DEFAULT_LIDARR_SCHEDULER_POLICY[lane];
    return Object.freeze({
      concurrency: overrides?.concurrency ?? defaults.concurrency,
      operationBudget: overrides?.operationBudget ?? defaults.operationBudget,
      retryAttempts: overrides?.retryAttempts ?? defaults.retryAttempts,
      retryBackoffCapMs: overrides?.retryBackoffCapMs ?? defaults.retryBackoffCapMs,
    });
  };

  return Object.freeze({
    "local-only": resolveLane("local-only", config?.lanes?.["local-only"]),
    "metadata-dependent": resolveLane("metadata-dependent", config?.lanes?.["metadata-dependent"]),
    discovery: resolveLane("discovery", config?.lanes?.discovery),
    destructive: resolveLane("destructive", config?.lanes?.destructive),
  });
}

/** Context supplied to one scheduled operation attempt. */
export interface LidarrScheduledTaskContext {
  /** One-based attempt number. */
  readonly attempt: number;
  /** Optional caller cancellation signal. */
  readonly signal?: AbortSignal;
}

/** One unit of Lidarr work submitted to a scheduler lane. */
export interface LidarrScheduledTask<T> {
  /** Stable caller-provided identifier within the batch. */
  readonly id: string;
  /** Human-readable operation name; must not contain credentials. */
  readonly operation: string;
  /** Whether repeating this complete unit of work is safe. */
  readonly idempotent: boolean;
  /** Executes one attempt. */
  readonly run: (context: LidarrScheduledTaskContext) => Promise<T>;
}

/** Scheduler-only terminal outcomes in addition to the Lidarr taxonomy. */
export type LidarrExecutionFailureType =
  | LidarrErrorCode
  | "discovery-provider-unavailable"
  | "aborted"
  | "budget-exhausted"
  | "unknown";

/** Safe execution metadata shared by action results and command failures. */
export interface LidarrExecutionMetadata {
  readonly taskId: string;
  readonly operation: string;
  readonly lane: LidarrTier;
  readonly outcome: "succeeded" | "failed" | "skipped";
  readonly attempts: number;
  readonly failureType?: LidarrExecutionFailureType;
  readonly statusCode?: number;
  readonly retryable?: boolean;
  readonly retryAfterSeconds?: number;
}

/** Successful execution metadata without the operation's domain value. */
export interface LidarrExecutionSuccessMetadata extends LidarrExecutionMetadata {
  readonly outcome: "succeeded";
}

/** Successful scheduled operation. */
export interface LidarrExecutionSuccess<T> extends LidarrExecutionMetadata {
  readonly outcome: "succeeded";
  readonly value: T;
}

/** Terminal failed scheduled operation. */
export interface LidarrExecutionFailure extends LidarrExecutionMetadata {
  readonly outcome: "failed";
  readonly failureType: LidarrExecutionFailureType;
}

/** Operation not admitted because of budget or cancellation. */
export interface LidarrExecutionSkipped extends LidarrExecutionMetadata {
  readonly outcome: "skipped";
  readonly failureType: "aborted" | "budget-exhausted";
}

/** Structured result for one scheduled operation. */
export type LidarrExecutionResult<T> =
  | LidarrExecutionSuccess<T>
  | LidarrExecutionFailure
  | LidarrExecutionSkipped;

/** Aggregate counts for one lane batch. */
export interface LidarrBatchSummary {
  readonly total: number;
  readonly admitted: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
  readonly attempts: number;
}

/** Ordered result of one lane batch. */
export interface LidarrBatchResult<T> {
  readonly lane: LidarrTier;
  readonly summary: LidarrBatchSummary;
  readonly results: readonly LidarrExecutionResult<T>[];
}

/** Lane whose descriptor requires a health/circuit preflight. */
export type GatedLidarrTier = {
  [TTier in LidarrTier]: (typeof LIDARR_TIER_DESCRIPTORS)[TTier]["requiresHealthGate"] extends true
    ? TTier
    : never;
}[LidarrTier];

/** Context supplied to a gated lane preflight. */
export interface LidarrSchedulerPreflightContext {
  readonly lane: GatedLidarrTier;
  readonly signal?: AbortSignal;
}

/** Health/circuit preflight required before a gated batch may dispatch. */
export type LidarrSchedulerPreflight = (context: LidarrSchedulerPreflightContext) => Promise<void>;

/** Result of attempting to serve a failed single operation without another live request. */
export type LidarrTerminalFallbackResult<T> =
  | { readonly served: true; readonly value: T }
  | { readonly served: false };

/** Terminal fallback invoked with the original final live or preflight error. */
export type LidarrTerminalFallback<T> = (
  error: unknown,
) => Promise<LidarrTerminalFallbackResult<T>>;

/** Options common to single and batch scheduling. */
export type LidarrScheduleOptions<TTier extends LidarrTier = LidarrTier> = {
  readonly signal?: AbortSignal;
} & (TTier extends GatedLidarrTier
  ? { readonly preflight: LidarrSchedulerPreflight }
  : { readonly preflight?: never });

type LidarrScheduleOptionArgs<TTier extends LidarrTier> = TTier extends GatedLidarrTier
  ? [options: LidarrScheduleOptions<TTier>]
  : [options?: LidarrScheduleOptions<TTier>];

/** Options for the throwing single-task scheduler API. */
export type LidarrRunSingleOptions<
  T,
  TTier extends LidarrTier = LidarrTier,
> = LidarrScheduleOptions<TTier> & {
  readonly terminalFallback?: LidarrTerminalFallback<T>;
};

type LidarrRunSingleOptionArgs<T, TTier extends LidarrTier> = TTier extends GatedLidarrTier
  ? [options: LidarrRunSingleOptions<T, TTier>]
  : [options?: LidarrRunSingleOptions<T, TTier>];

interface InternalLidarrScheduleOptions {
  readonly signal?: AbortSignal;
  readonly preflight?: LidarrSchedulerPreflight;
}

interface InternalLidarrRunSingleOptions<T> extends InternalLidarrScheduleOptions {
  readonly terminalFallback?: LidarrTerminalFallback<T>;
}

/** Result of the throwing single-task convenience API. */
export interface LidarrSingleExecutionResult<T> {
  readonly value: T;
  readonly execution: LidarrExecutionSuccessMetadata;
}

/** Test seams for deterministic scheduler behavior. */
export interface LidarrSchedulerDependencies {
  readonly delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
}

/** Public scheduler contract used by Lidarr actions and future batch commands. */
export interface LidarrScheduler {
  readonly policy: ResolvedLidarrSchedulerPolicy;
  runBatch<T, TTier extends LidarrTier>(
    lane: TTier,
    tasks: readonly LidarrScheduledTask<T>[],
    ...options: LidarrScheduleOptionArgs<TTier>
  ): Promise<LidarrBatchResult<T>>;
  runSingle<T, TTier extends LidarrTier>(
    lane: TTier,
    task: LidarrScheduledTask<T>,
    ...options: LidarrRunSingleOptionArgs<T, TTier>
  ): Promise<LidarrSingleExecutionResult<T>>;
}

interface InternalExecutionResult<T> {
  readonly result: LidarrExecutionResult<T>;
  readonly error?: unknown;
}

type LidarrPreflightResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown };

const executionMetadataByError = new WeakMap<object, LidarrExecutionMetadata>();

/** Returns scheduler metadata attached to a thrown object, when available. */
export function readLidarrExecutionMetadata(error: unknown): LidarrExecutionMetadata | undefined {
  return typeof error === "object" && error !== null
    ? executionMetadataByError.get(error)
    : undefined;
}

/** Adapts the shipped health/circuit gate to the scheduler preflight contract. */
export function createLidarrSchedulerPreflight(
  client: LidarrClientApi,
  breakers: {
    readonly lidarr: LidarrCircuitBreaker;
    readonly metadata: LidarrCircuitBreaker;
  },
): LidarrSchedulerPreflight {
  return async ({ lane, signal }): Promise<void> => {
    await ensureTierHealthy(client, lane, breakers, signal);
  };
}

function defaultDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Operation aborted", "AbortError"));
      return;
    }

    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new DOMException("Operation aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortFailure(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

type ScheduledErrorCode = Exclude<
  LidarrExecutionFailureType,
  "aborted" | "budget-exhausted" | "unknown"
>;

interface ScheduledErrorView {
  readonly code: ScheduledErrorCode;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly retryAfterSeconds?: number;
}

function isScheduledErrorCode(value: unknown): value is ScheduledErrorCode {
  switch (value) {
    case "lidarr-unreachable":
    case "metadata-provider-unavailable":
    case "discovery-provider-unavailable":
    case "rate-limited":
    case "validation":
    case "authentication":
    case "authorization":
    case "not-found":
    case "invalid-response":
    case "timeout":
    case "configuration":
      return true;
    default:
      return false;
  }
}

function isOptionalSafeInteger(
  value: unknown,
  minimum: number,
  maximum?: number,
): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= minimum &&
      (maximum === undefined || value <= maximum))
  );
}

function readScheduledError(error: unknown): ScheduledErrorView | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as {
    readonly code?: unknown;
    readonly retryable?: unknown;
    readonly statusCode?: unknown;
    readonly retryAfterSeconds?: unknown;
  };
  if (
    !isScheduledErrorCode(candidate.code) ||
    typeof candidate.retryable !== "boolean" ||
    !isOptionalSafeInteger(candidate.statusCode, 100, 599) ||
    !isOptionalSafeInteger(candidate.retryAfterSeconds, 0)
  ) {
    return undefined;
  }
  return {
    code: candidate.code,
    retryable: candidate.retryable,
    ...(candidate.statusCode === undefined ? {} : { statusCode: candidate.statusCode }),
    ...(candidate.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: candidate.retryAfterSeconds }),
  };
}

function classifyFailure(
  error: unknown,
): Pick<LidarrExecutionFailure, "failureType" | "statusCode" | "retryable" | "retryAfterSeconds"> {
  const scheduledError = readScheduledError(error);
  if (scheduledError !== undefined) {
    return {
      failureType: scheduledError.code,
      statusCode: scheduledError.statusCode,
      retryable: scheduledError.retryable,
      retryAfterSeconds: scheduledError.retryAfterSeconds,
    };
  }
  return { failureType: "unknown", retryable: false };
}

function retryDelayMs(
  error: ScheduledErrorView,
  attempt: number,
  policy: LidarrLanePolicy,
  random: () => number,
): number | undefined {
  if (error.code === "rate-limited" && error.retryAfterSeconds !== undefined) {
    const waitMs = error.retryAfterSeconds * 1_000;
    return waitMs > policy.retryBackoffCapMs ? undefined : waitMs;
  }
  const base = error.code === "timeout" ? TIMEOUT_RETRY_BASE_DELAY_MS : RETRY_BASE_DELAY_MS;
  const exponential = base * 2 ** (attempt - 1);
  return Math.min(exponential + random() * exponential, policy.retryBackoffCapMs);
}

function shouldRetry(
  lane: LidarrTier,
  task: LidarrScheduledTask<unknown>,
  error: ScheduledErrorView,
  attempt: number,
  policy: LidarrLanePolicy,
): boolean {
  if (
    lane === "destructive" ||
    !task.idempotent ||
    attempt > policy.retryAttempts ||
    !error.retryable
  ) {
    return false;
  }
  switch (error.code) {
    case "discovery-provider-unavailable":
      return lane === "discovery";
    case "lidarr-unreachable":
    case "timeout":
    case "rate-limited":
      return true;
    case "metadata-provider-unavailable":
    case "validation":
    case "authentication":
    case "authorization":
    case "not-found":
    case "invalid-response":
    case "configuration":
      return false;
    default: {
      const exhaustive: never = error.code;
      throw new Error(`Unhandled scheduled error code: ${String(exhaustive)}`);
    }
  }
}

function toMetadata<T>(result: LidarrExecutionResult<T>): LidarrExecutionMetadata {
  return {
    taskId: result.taskId,
    operation: result.operation,
    lane: result.lane,
    outcome: result.outcome,
    attempts: result.attempts,
    failureType: result.failureType,
    statusCode: result.statusCode,
    retryable: result.retryable,
    retryAfterSeconds: result.retryAfterSeconds,
  };
}

function preflightFailureResult<T>(
  lane: LidarrTier,
  task: LidarrScheduledTask<T>,
  error: unknown,
  signal?: AbortSignal,
): InternalExecutionResult<T> {
  if (isAbortFailure(error, signal)) {
    return {
      result: {
        taskId: task.id,
        operation: task.operation,
        lane,
        outcome: "skipped",
        attempts: 0,
        failureType: "aborted",
        retryable: false,
      },
      error,
    };
  }
  return {
    result: {
      taskId: task.id,
      operation: task.operation,
      lane,
      outcome: "failed",
      attempts: 0,
      ...classifyFailure(error),
    },
    error,
  };
}

/** Creates one scheduler whose lane limiters are shared across every run. */
export function createLidarrScheduler(
  policy: ResolvedLidarrSchedulerPolicy,
  dependencies: LidarrSchedulerDependencies = {},
): LidarrScheduler {
  const delay = dependencies.delay ?? defaultDelay;
  const random = dependencies.random ?? Math.random;
  const limiters: Readonly<Record<LidarrTier, ReturnType<typeof pLimit>>> = {
    "local-only": pLimit(policy["local-only"].concurrency),
    "metadata-dependent": pLimit(policy["metadata-dependent"].concurrency),
    discovery: pLimit(policy.discovery.concurrency),
    destructive: pLimit(policy.destructive.concurrency),
  };

  const executeTask = async <T>(
    lane: LidarrTier,
    task: LidarrScheduledTask<T>,
    signal?: AbortSignal,
  ): Promise<InternalExecutionResult<T>> => {
    if (signal?.aborted) {
      return {
        result: {
          taskId: task.id,
          operation: task.operation,
          lane,
          outcome: "skipped",
          attempts: 0,
          failureType: "aborted",
          retryable: false,
        },
      };
    }

    const lanePolicy = policy[lane];
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const value = await task.run({ attempt, signal });
        return {
          result: {
            taskId: task.id,
            operation: task.operation,
            lane,
            outcome: "succeeded",
            attempts: attempt,
            value,
          },
        };
      } catch (error) {
        if (isAbortFailure(error, signal)) {
          return {
            result: {
              taskId: task.id,
              operation: task.operation,
              lane,
              outcome: "skipped",
              attempts: attempt,
              failureType: "aborted",
              retryable: false,
            },
            error,
          };
        }

        const scheduledError = readScheduledError(error);
        if (
          scheduledError !== undefined &&
          shouldRetry(lane, task, scheduledError, attempt, lanePolicy)
        ) {
          const waitMs = retryDelayMs(scheduledError, attempt, lanePolicy, random);
          if (waitMs !== undefined) {
            try {
              await delay(waitMs, signal);
              continue;
            } catch (delayError) {
              if (isAbortFailure(delayError, signal)) {
                return {
                  result: {
                    taskId: task.id,
                    operation: task.operation,
                    lane,
                    outcome: "skipped",
                    attempts: attempt,
                    failureType: "aborted",
                    retryable: false,
                  },
                  error: delayError,
                };
              }
              error = delayError;
            }
          }
        }

        const failure = classifyFailure(error);
        return {
          result: {
            taskId: task.id,
            operation: task.operation,
            lane,
            outcome: "failed",
            attempts: attempt,
            ...failure,
          },
          error,
        };
      }
    }
  };

  const scheduleInternal = <T>(
    lane: LidarrTier,
    task: LidarrScheduledTask<T>,
    signal?: AbortSignal,
  ): Promise<InternalExecutionResult<T>> => limiters[lane](() => executeTask(lane, task, signal));

  const runPreflight = async (
    lane: LidarrTier,
    admitted: number,
    options: InternalLidarrScheduleOptions,
  ): Promise<LidarrPreflightResult> => {
    if (admitted === 0 || !LIDARR_TIER_DESCRIPTORS[lane].requiresHealthGate) {
      return { ok: true };
    }
    if (options.signal?.aborted) {
      return {
        ok: false,
        error: options.signal.reason ?? new DOMException("Operation aborted", "AbortError"),
      };
    }
    if (options.preflight === undefined) {
      return {
        ok: false,
        error: new LidarrValidationError(
          `lidarr ${lane} scheduler preflight`,
          `A scheduler preflight is required for the ${lane} lane`,
          "configuration",
        ),
      };
    }
    const preflight = options.preflight;
    try {
      await limiters[lane](async () => {
        if (options.signal?.aborted) {
          throw options.signal.reason ?? new DOMException("Operation aborted", "AbortError");
        }
        await preflight({ lane: lane as GatedLidarrTier, signal: options.signal });
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  };

  const runBatch = async <T, TTier extends LidarrTier>(
    lane: TTier,
    tasks: readonly LidarrScheduledTask<T>[],
    ...optionArgs: LidarrScheduleOptionArgs<TTier>
  ): Promise<LidarrBatchResult<T>> => {
    const budget = policy[lane].operationBudget;
    const admitted = Math.min(tasks.length, budget);
    const options = (optionArgs[0] ?? {}) as InternalLidarrScheduleOptions;
    const preflight = await runPreflight(lane, admitted, options);
    const internal = await Promise.all(
      tasks.map((task, index): Promise<InternalExecutionResult<T>> => {
        if (index >= budget) {
          return Promise.resolve({
            result: {
              taskId: task.id,
              operation: task.operation,
              lane,
              outcome: "skipped",
              attempts: 0,
              failureType: "budget-exhausted",
              retryable: false,
            },
          });
        }
        if (!preflight.ok) {
          return Promise.resolve(
            preflightFailureResult(lane, task, preflight.error, options.signal),
          );
        }
        return scheduleInternal(lane, task, options.signal);
      }),
    );
    const results = internal.map(({ result }) => result);
    const summary: LidarrBatchSummary = {
      total: tasks.length,
      admitted,
      succeeded: results.filter((result) => result.outcome === "succeeded").length,
      failed: results.filter((result) => result.outcome === "failed").length,
      skipped: results.filter((result) => result.outcome === "skipped").length,
      attempts: results.reduce((total, result) => total + result.attempts, 0),
    };
    return Object.freeze({
      lane,
      summary: Object.freeze(summary),
      results: Object.freeze(results),
    });
  };

  const runSingle = async <T, TTier extends LidarrTier>(
    lane: TTier,
    task: LidarrScheduledTask<T>,
    ...optionArgs: LidarrRunSingleOptionArgs<T, TTier>
  ): Promise<LidarrSingleExecutionResult<T>> => {
    const options = (optionArgs[0] ?? {}) as InternalLidarrRunSingleOptions<T>;
    const preflight = await runPreflight(lane, 1, options);
    const internal = preflight.ok
      ? await scheduleInternal(lane, task, options.signal)
      : preflightFailureResult(lane, task, preflight.error, options.signal);
    if (internal.result.outcome === "succeeded") {
      return {
        value: internal.result.value,
        execution: {
          taskId: internal.result.taskId,
          operation: internal.result.operation,
          lane: internal.result.lane,
          outcome: "succeeded",
          attempts: internal.result.attempts,
        },
      };
    }

    const error =
      internal.error ??
      options.signal?.reason ??
      new DOMException(
        internal.result.failureType === "budget-exhausted"
          ? "Lidarr operation budget exhausted"
          : "Lidarr operation aborted",
        internal.result.failureType === "aborted" ? "AbortError" : "Error",
      );

    if (internal.result.failureType !== "aborted" && options.terminalFallback !== undefined) {
      try {
        const fallback = await options.terminalFallback(error);
        if (fallback.served) {
          return {
            value: fallback.value,
            execution: {
              taskId: internal.result.taskId,
              operation: internal.result.operation,
              lane: internal.result.lane,
              outcome: "succeeded",
              attempts: internal.result.attempts,
            },
          };
        }
      } catch {
        // Preserve the original terminal failure when fallback serving fails.
      }
    }

    if (typeof error === "object" && error !== null) {
      executionMetadataByError.set(error, toMetadata(internal.result));
    }
    throw error;
  };

  return Object.freeze({ policy, runBatch, runSingle });
}
