import { describe, expect, it, vi } from "vitest";

import { createLidarrClientMock } from "../../actions/test-helpers/lidarr-client-mocks.js";
import type { LidarrSchedulerConfigOptions } from "../../types/config.js";
import type {
  CircuitDecision,
  CircuitScope,
  CircuitState,
  LidarrCircuitBreaker,
} from "./circuit-breaker.js";
import {
  LidarrTimeoutError,
  LidarrUnreachableError,
  LidarrValidationError,
  MetadataProviderUnavailableError,
  RateLimitedError,
} from "./errors.js";
import {
  DEFAULT_LIDARR_SCHEDULER_POLICY,
  createLidarrScheduler,
  createLidarrSchedulerPreflight,
  readLidarrExecutionMetadata,
  resolveLidarrSchedulerPolicy,
  type LidarrBatchResult,
  type LidarrScheduledTask,
} from "./scheduler.js";

const CLOSED: CircuitState = { state: "closed", recentFailures: [] };
const ALLOW: CircuitDecision = { allowed: true, probe: false, next: CLOSED };

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (): void => {
      resolvePromise?.();
    },
  };
}

function createPolicy(config?: LidarrSchedulerConfigOptions) {
  return resolveLidarrSchedulerPolicy(config);
}

function task<T>(
  id: string,
  run: LidarrScheduledTask<T>["run"],
  idempotent = true,
): LidarrScheduledTask<T> {
  return { id, operation: `test ${id}`, idempotent, run };
}

function breaker(scope: CircuitScope): LidarrCircuitBreaker {
  return {
    origin: "http://localhost:8686",
    scope,
    gate: vi.fn(() => ALLOW),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    getState: vi.fn(() => CLOSED),
  };
}

describe("resolveLidarrSchedulerPolicy", () => {
  it("returns exhaustive, deeply frozen safe defaults", () => {
    const policy = resolveLidarrSchedulerPolicy();

    expect(policy).toEqual(DEFAULT_LIDARR_SCHEDULER_POLICY);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.values(policy).every(Object.isFrozen)).toBe(true);
    expect(policy.destructive).toMatchObject({ concurrency: 1, retryAttempts: 0 });
  });

  it("applies partial lane overrides without mutating defaults", () => {
    const policy = createPolicy({
      lanes: {
        "local-only": { concurrency: 3 },
        discovery: { retryAttempts: 4, operationBudget: 7 },
      },
    });

    expect(policy["local-only"].concurrency).toBe(3);
    expect(policy["local-only"].operationBudget).toBe(1_000);
    expect(policy.discovery.retryAttempts).toBe(4);
    expect(policy.discovery.operationBudget).toBe(7);
    expect(DEFAULT_LIDARR_SCHEDULER_POLICY["local-only"].concurrency).toBe(8);
  });
});

describe("createLidarrScheduler", () => {
  it("returns an empty ordered batch without invoking work", async () => {
    const scheduler = createLidarrScheduler(createPolicy());

    await expect(scheduler.runBatch("local-only", [])).resolves.toEqual({
      lane: "local-only",
      summary: { total: 0, admitted: 0, succeeded: 0, failed: 0, skipped: 0, attempts: 0 },
      results: [],
    });
  });

  it("runs a gated batch preflight exactly once before task closures", async () => {
    const order: string[] = [];
    const preflight = vi.fn(async () => {
      order.push("preflight");
    });
    const scheduler = createLidarrScheduler(createPolicy());

    const result = await scheduler.runBatch(
      "metadata-dependent",
      [
        task("one", async () => {
          order.push("task:one");
          return 1;
        }),
        task("two", async () => {
          order.push("task:two");
          return 2;
        }),
      ],
      { preflight },
    );

    expect(preflight).toHaveBeenCalledOnce();
    expect(preflight).toHaveBeenCalledWith({ lane: "metadata-dependent", signal: undefined });
    expect(order[0]).toBe("preflight");
    expect(result.summary.succeeded).toBe(2);
  });

  it.each(["local-only", "discovery", "destructive"] as const)(
    "does not run a supplied preflight for ungated lane %s",
    async (lane) => {
      const preflight = vi.fn().mockResolvedValue(undefined);
      const closure = vi.fn().mockResolvedValue("ok");
      const scheduler = createLidarrScheduler(createPolicy());
      const result = (await Reflect.apply(scheduler.runBatch, scheduler, [
        lane,
        [task("ungated", closure)],
        { preflight },
      ])) as LidarrBatchResult<string>;

      expect(preflight).not.toHaveBeenCalled();
      expect(closure).toHaveBeenCalledOnce();
      expect(result.results[0]?.outcome).toBe("succeeded");
    },
  );

  it("does not run preflight for an empty gated batch", async () => {
    const preflight = vi.fn().mockResolvedValue(undefined);
    const scheduler = createLidarrScheduler(createPolicy());

    const result = await scheduler.runBatch("metadata-dependent", [], { preflight });

    expect(preflight).not.toHaveBeenCalled();
    expect(result.summary).toEqual({
      total: 0,
      admitted: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      attempts: 0,
    });
  });

  it("skips a pre-aborted gated batch without invoking preflight or task closures", async () => {
    const controller = new AbortController();
    controller.abort();
    const preflight = vi.fn().mockResolvedValue(undefined);
    const closure = vi.fn().mockResolvedValue("unsafe");
    const scheduler = createLidarrScheduler(createPolicy());

    const result = await scheduler.runBatch("metadata-dependent", [task("aborted", closure)], {
      preflight,
      signal: controller.signal,
    });

    expect(preflight).not.toHaveBeenCalled();
    expect(closure).not.toHaveBeenCalled();
    expect(result.summary).toEqual({
      total: 1,
      admitted: 1,
      succeeded: 0,
      failed: 0,
      skipped: 1,
      attempts: 0,
    });
    expect(result.results[0]).toMatchObject({
      taskId: "aborted",
      outcome: "skipped",
      attempts: 0,
      failureType: "aborted",
      retryable: false,
    });
  });

  it("fails a gated batch safely when its required preflight is missing", async () => {
    const closure = vi.fn().mockResolvedValue("unsafe");
    const scheduler = createLidarrScheduler(createPolicy());
    const result = (await Reflect.apply(scheduler.runBatch, scheduler, [
      "metadata-dependent",
      [task("missing", closure)],
    ])) as LidarrBatchResult<string>;

    expect(closure).not.toHaveBeenCalled();
    expect(result.summary).toEqual({
      total: 1,
      admitted: 1,
      succeeded: 0,
      failed: 1,
      skipped: 0,
      attempts: 0,
    });
    expect(result.results[0]).toMatchObject({
      taskId: "missing",
      outcome: "failed",
      attempts: 0,
      failureType: "configuration",
      retryable: false,
    });
  });

  it("classifies one preflight failure across the admitted batch without running tasks", async () => {
    const failure = new MetadataProviderUnavailableError("lidarr health gate");
    const preflight = vi.fn().mockRejectedValue(failure);
    const closure = vi.fn().mockResolvedValue("unsafe");
    const scheduler = createLidarrScheduler(createPolicy());

    const result = await scheduler.runBatch(
      "metadata-dependent",
      [task("one", closure), task("two", closure)],
      { preflight },
    );

    expect(preflight).toHaveBeenCalledOnce();
    expect(closure).not.toHaveBeenCalled();
    expect(result.summary).toMatchObject({ admitted: 2, failed: 2, attempts: 0 });
    expect(result.results).toEqual([
      expect.objectContaining({
        taskId: "one",
        outcome: "failed",
        attempts: 0,
        failureType: "metadata-provider-unavailable",
        retryable: true,
      }),
      expect.objectContaining({
        taskId: "two",
        outcome: "failed",
        attempts: 0,
        failureType: "metadata-provider-unavailable",
        retryable: true,
      }),
    ]);
  });

  it("rethrows the exact preflight error from runSingle with safe metadata", async () => {
    const failure = new LidarrUnreachableError("lidarr health gate", "gate failed with secret");
    const preflight = vi.fn().mockRejectedValue(failure);
    const closure = vi.fn().mockResolvedValue("unsafe");
    const scheduler = createLidarrScheduler(createPolicy());

    let thrown: unknown;
    try {
      await scheduler.runSingle("metadata-dependent", task("single", closure), { preflight });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(failure);
    expect(closure).not.toHaveBeenCalled();
    expect(readLidarrExecutionMetadata(thrown)).toMatchObject({
      taskId: "single",
      lane: "metadata-dependent",
      outcome: "failed",
      attempts: 0,
      failureType: "lidarr-unreachable",
    });
  });

  it("serves a terminal fallback after preflight rejection with zero live attempts", async () => {
    const failure = new MetadataProviderUnavailableError("lidarr health gate");
    const preflight = vi.fn().mockRejectedValue(failure);
    const closure = vi.fn().mockResolvedValue("unsafe");
    const terminalFallback = vi.fn(async (error: unknown) => {
      expect(error).toBe(failure);
      return { served: true as const, value: "cached" };
    });
    const scheduler = createLidarrScheduler(createPolicy());

    const result = await scheduler.runSingle("metadata-dependent", task("lookup", closure), {
      preflight,
      terminalFallback,
    });

    expect(result).toEqual({
      value: "cached",
      execution: {
        taskId: "lookup",
        operation: "test lookup",
        lane: "metadata-dependent",
        outcome: "succeeded",
        attempts: 0,
      },
    });
    expect(closure).not.toHaveBeenCalled();
    expect(terminalFallback).toHaveBeenCalledOnce();
  });

  it("preserves the preflight error and metadata when terminal fallback misses", async () => {
    const failure = new LidarrUnreachableError("lidarr health gate");
    const preflight = vi.fn().mockRejectedValue(failure);
    const terminalFallback = vi.fn().mockResolvedValue({ served: false as const });
    const scheduler = createLidarrScheduler(createPolicy());

    let thrown: unknown;
    try {
      await scheduler.runSingle("metadata-dependent", task("lookup", vi.fn()), {
        preflight,
        terminalFallback,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(failure);
    expect(terminalFallback).toHaveBeenCalledOnce();
    expect(readLidarrExecutionMetadata(thrown)).toEqual({
      taskId: "lookup",
      operation: "test lookup",
      lane: "metadata-dependent",
      outcome: "failed",
      attempts: 0,
      failureType: "lidarr-unreachable",
      statusCode: undefined,
      retryable: true,
      retryAfterSeconds: undefined,
    });
  });

  it("adapts ensureTierHealthy into the scheduler preflight contract", async () => {
    const client = createLidarrClientMock();
    const lidarr = breaker("lidarr");
    const metadata = breaker("metadata");
    const preflight = createLidarrSchedulerPreflight(client, { lidarr, metadata });

    await preflight({ lane: "metadata-dependent" });

    expect(lidarr.gate).toHaveBeenCalledOnce();
    expect(metadata.gate).toHaveBeenCalledOnce();
    expect(client.getHealth).toHaveBeenCalledOnce();
  });

  it("isolates concurrency between lanes", async () => {
    const release = deferred();
    let localActive = 0;
    let metadataActive = 0;
    let localMax = 0;
    let metadataMax = 0;
    const scheduler = createLidarrScheduler(
      createPolicy({
        lanes: {
          "local-only": { concurrency: 2 },
          "metadata-dependent": { concurrency: 1 },
        },
      }),
    );
    const createBlockingTask = (id: string, lane: "local" | "metadata") =>
      task(id, async () => {
        if (lane === "local") {
          localActive += 1;
          localMax = Math.max(localMax, localActive);
        } else {
          metadataActive += 1;
          metadataMax = Math.max(metadataMax, metadataActive);
        }
        await release.promise;
        if (lane === "local") localActive -= 1;
        else metadataActive -= 1;
        return id;
      });

    const localRun = scheduler.runBatch("local-only", [
      createBlockingTask("l1", "local"),
      createBlockingTask("l2", "local"),
      createBlockingTask("l3", "local"),
    ]);
    const metadataRun = scheduler.runBatch(
      "metadata-dependent",
      [createBlockingTask("m1", "metadata"), createBlockingTask("m2", "metadata")],
      { preflight: async () => undefined },
    );

    await vi.waitFor(() => {
      expect(localActive).toBe(2);
      expect(metadataActive).toBe(1);
    });
    release.resolve();
    await Promise.all([localRun, metadataRun]);
    expect(localMax).toBe(2);
    expect(metadataMax).toBe(1);
  });

  it("shares a lane limiter across simultaneous batches", async () => {
    const release = deferred();
    let active = 0;
    let maximum = 0;
    const scheduler = createLidarrScheduler(
      createPolicy({ lanes: { "local-only": { concurrency: 1 } } }),
    );
    const blocking = (id: string) =>
      task(id, async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await release.promise;
        active -= 1;
        return id;
      });

    const first = scheduler.runBatch("local-only", [blocking("one"), blocking("two")]);
    const second = scheduler.runBatch("local-only", [blocking("three")]);
    await vi.waitFor(() => expect(active).toBe(1));
    release.resolve();
    await Promise.all([first, second]);
    expect(maximum).toBe(1);
  });

  it("shares gated lane capacity between preflights and tasks across concurrent batches", async () => {
    const firstTaskStarted = deferred();
    const releaseFirstTask = deferred();
    const order: string[] = [];
    let active = 0;
    let maximum = 0;
    const enter = async (label: string, wait?: Promise<void>): Promise<void> => {
      active += 1;
      maximum = Math.max(maximum, active);
      order.push(label);
      await wait;
      active -= 1;
    };
    const scheduler = createLidarrScheduler(
      createPolicy({ lanes: { "metadata-dependent": { concurrency: 1 } } }),
    );
    const firstPreflight = vi.fn(async () => {
      await enter("preflight:first");
    });
    const secondPreflight = vi.fn(async () => {
      await enter("preflight:second");
    });

    const first = scheduler.runBatch(
      "metadata-dependent",
      [
        task("first", async () => {
          firstTaskStarted.resolve();
          await enter("task:first", releaseFirstTask.promise);
          return "first";
        }),
      ],
      { preflight: firstPreflight },
    );
    await firstTaskStarted.promise;

    const second = scheduler.runBatch(
      "metadata-dependent",
      [
        task("second", async () => {
          await enter("task:second");
          return "second";
        }),
      ],
      { preflight: secondPreflight },
    );
    await Promise.resolve();

    const activeBeforeRelease = active;
    const secondPreflightRanBeforeRelease = secondPreflight.mock.calls.length > 0;
    releaseFirstTask.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(activeBeforeRelease).toBe(1);
    expect(secondPreflightRanBeforeRelease).toBe(false);
    expect(firstPreflight).toHaveBeenCalledOnce();
    expect(secondPreflight).toHaveBeenCalledOnce();
    expect(maximum).toBe(1);
    expect(order).toEqual(["preflight:first", "task:first", "preflight:second", "task:second"]);
    expect(firstResult.summary.succeeded).toBe(1);
    expect(secondResult.summary.succeeded).toBe(1);
  });

  it("preserves input ordering when tasks complete out of order", async () => {
    const first = deferred();
    const second = deferred();
    const scheduler = createLidarrScheduler(
      createPolicy({ lanes: { "local-only": { concurrency: 2 } } }),
    );
    const run = scheduler.runBatch("local-only", [
      task("first", async () => {
        await first.promise;
        return 1;
      }),
      task("second", async () => {
        await second.promise;
        return 2;
      }),
    ]);

    second.resolve();
    await Promise.resolve();
    first.resolve();
    const result = await run;
    expect(result.results.map((entry) => entry.taskId)).toEqual(["first", "second"]);
    expect(result.results.map((entry) => entry.outcome)).toEqual(["succeeded", "succeeded"]);
  });

  it("skips budget overflow without invoking those closures", async () => {
    const invoked: string[] = [];
    const scheduler = createLidarrScheduler(
      createPolicy({ lanes: { "local-only": { operationBudget: 2 } } }),
    );
    const result = await scheduler.runBatch(
      "local-only",
      ["one", "two", "three"].map((id) =>
        task(id, async () => {
          invoked.push(id);
          return id;
        }),
      ),
    );

    expect(invoked).toEqual(["one", "two"]);
    expect(result.summary).toEqual({
      total: 3,
      admitted: 2,
      succeeded: 2,
      failed: 0,
      skipped: 1,
      attempts: 2,
    });
    expect(result.results[2]).toMatchObject({
      outcome: "skipped",
      failureType: "budget-exhausted",
      attempts: 0,
    });
  });

  it("retries an idempotent timeout with deterministic delay", async () => {
    const delay = vi.fn().mockResolvedValue(undefined);
    let attempts = 0;
    const scheduler = createLidarrScheduler(createPolicy(), { delay, random: () => 0 });
    const result = await scheduler.runSingle(
      "local-only",
      task("retry", async () => {
        attempts += 1;
        if (attempts === 1) throw new LidarrTimeoutError("test retry");
        return "ok";
      }),
    );

    expect(result).toMatchObject({ value: "ok", execution: { attempts: 2, outcome: "succeeded" } });
    expect(delay).toHaveBeenCalledOnce();
    expect(delay).toHaveBeenCalledWith(2_000, undefined);
  });

  it("retries a structural provider outage only for idempotent discovery work", async () => {
    const delay = vi.fn().mockResolvedValue(undefined);
    const failure = Object.freeze({
      code: "discovery-provider-unavailable" as const,
      retryable: true,
      statusCode: 503,
    });
    const discoveryRun = vi
      .fn<LidarrScheduledTask<string>["run"]>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue("ok");
    const scheduler = createLidarrScheduler(createPolicy(), { delay, random: () => 0 });

    const success = await scheduler.runSingle("discovery", task("lastfm", discoveryRun, true));

    expect(success.execution.attempts).toBe(2);
    expect(discoveryRun).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(500, undefined);

    const nonIdempotentRun = vi.fn().mockRejectedValue(failure);
    const nonIdempotent = await scheduler.runBatch("discovery", [
      task("lastfm-write", nonIdempotentRun, false),
    ]);
    expect(nonIdempotentRun).toHaveBeenCalledOnce();
    expect(nonIdempotent.results[0]).toMatchObject({
      outcome: "failed",
      attempts: 1,
      failureType: "discovery-provider-unavailable",
      statusCode: 503,
      retryable: true,
    });
  });

  it("does not retry or reclassify a discovery outage in a Lidarr lane", async () => {
    const delay = vi.fn().mockResolvedValue(undefined);
    const failure = Object.freeze({
      code: "discovery-provider-unavailable" as const,
      retryable: true,
    });
    const run = vi.fn().mockRejectedValue(failure);
    const scheduler = createLidarrScheduler(createPolicy(), { delay, random: () => 0 });

    const result = await scheduler.runBatch("local-only", [task("lidarr-read", run)]);

    expect(run).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({
      outcome: "failed",
      attempts: 1,
      failureType: "discovery-provider-unavailable",
      retryable: true,
    });
  });

  it("rejects unsafe structural error metadata instead of exposing or retrying it", async () => {
    const delay = vi.fn().mockResolvedValue(undefined);
    const failure = Object.freeze({
      code: "discovery-provider-unavailable",
      retryable: true,
      statusCode: 999,
      retryAfterSeconds: Number.POSITIVE_INFINITY,
    });
    const run = vi.fn().mockRejectedValue(failure);
    const scheduler = createLidarrScheduler(createPolicy(), { delay, random: () => 0 });

    const result = await scheduler.runBatch("discovery", [task("unsafe-provider-error", run)]);

    expect(run).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({
      outcome: "failed",
      attempts: 1,
      failureType: "unknown",
      retryable: false,
    });
    expect(result.results[0]).not.toHaveProperty("statusCode", 999);
  });

  it("waits for retry exhaustion before invoking terminal fallback once", async () => {
    const order: string[] = [];
    const delay = vi.fn(async () => {
      order.push("delay");
    });
    const liveFailure = new LidarrTimeoutError("lookup");
    const run = vi.fn(async () => {
      order.push("live");
      throw liveFailure;
    });
    const terminalFallback = vi.fn(async (error: unknown) => {
      order.push("fallback");
      expect(error).toBe(liveFailure);
      return { served: true as const, value: "cached" };
    });
    const scheduler = createLidarrScheduler(createPolicy(), { delay, random: () => 0 });

    const result = await scheduler.runSingle("local-only", task("lookup", run), {
      terminalFallback,
    });

    expect(order).toEqual(["live", "delay", "live", "fallback"]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(terminalFallback).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      value: "cached",
      execution: { taskId: "lookup", outcome: "succeeded", attempts: 2 },
    });
  });

  it("does not invoke terminal fallback after a successful live call", async () => {
    const terminalFallback = vi.fn().mockResolvedValue({ served: true as const, value: "cached" });
    const scheduler = createLidarrScheduler(createPolicy());

    const result = await scheduler.runSingle(
      "local-only",
      task("lookup", async () => "live"),
      { terminalFallback },
    );

    expect(result.value).toBe("live");
    expect(result.execution.attempts).toBe(1);
    expect(terminalFallback).not.toHaveBeenCalled();
  });

  it("does not invoke terminal fallback for caller cancellation", async () => {
    const cancellation = new DOMException("cancelled", "AbortError");
    const terminalFallback = vi.fn().mockResolvedValue({ served: true as const, value: "cached" });
    const scheduler = createLidarrScheduler(createPolicy());

    let thrown: unknown;
    try {
      await scheduler.runSingle(
        "local-only",
        task("lookup", async () => {
          throw cancellation;
        }),
        { terminalFallback },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(cancellation);
    expect(terminalFallback).not.toHaveBeenCalled();
    expect(readLidarrExecutionMetadata(thrown)).toMatchObject({
      taskId: "lookup",
      outcome: "skipped",
      attempts: 1,
      failureType: "aborted",
    });
  });

  it("preserves the original error and metadata when terminal fallback throws", async () => {
    const original = new LidarrValidationError("lookup", "bad result");
    const terminalFallback = vi.fn().mockRejectedValue(new Error("cache failed"));
    const scheduler = createLidarrScheduler(createPolicy());

    let thrown: unknown;
    try {
      await scheduler.runSingle(
        "local-only",
        task("lookup", async () => {
          throw original;
        }),
        { terminalFallback },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(original);
    expect(terminalFallback).toHaveBeenCalledOnce();
    expect(readLidarrExecutionMetadata(thrown)).toEqual({
      taskId: "lookup",
      operation: "test lookup",
      lane: "local-only",
      outcome: "failed",
      attempts: 1,
      failureType: "validation",
      statusCode: undefined,
      retryable: false,
      retryAfterSeconds: undefined,
    });
  });

  it("honors Retry-After exactly and fails through above the cap", async () => {
    const delay = vi.fn().mockResolvedValue(undefined);
    let attempts = 0;
    const scheduler = createLidarrScheduler(createPolicy(), { delay, random: () => 0 });
    const success = await scheduler.runSingle(
      "local-only",
      task("rate", async () => {
        attempts += 1;
        if (attempts === 1) throw new RateLimitedError("rate", 2, { statusCode: 429 });
        return "ok";
      }),
    );
    expect(success.execution.attempts).toBe(2);
    expect(delay).toHaveBeenCalledWith(2_000, undefined);

    const failure = await scheduler.runBatch("local-only", [
      task("cap", async () => {
        throw new RateLimitedError("rate", 16, { statusCode: 429 });
      }),
    ]);
    expect(failure.results[0]).toMatchObject({
      outcome: "failed",
      attempts: 1,
      failureType: "rate-limited",
      retryAfterSeconds: 16,
    });
  });

  it.each([
    ["metadata outage", new MetadataProviderUnavailableError("lookup"), true, "local-only"],
    ["validation", new LidarrValidationError("test", "bad input"), true, "local-only"],
    ["non-idempotent", new LidarrUnreachableError("test"), false, "local-only"],
    ["destructive", new LidarrUnreachableError("test"), true, "destructive"],
  ] as const)("does not retry %s", async (_name, failure, idempotent, lane) => {
    const delay = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn().mockRejectedValue(failure);
    const scheduler = createLidarrScheduler(createPolicy(), { delay, random: () => 0 });

    const result = await scheduler.runBatch(lane, [task("no-retry", run, idempotent)]);

    expect(run).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
    expect(result.results[0]?.attempts).toBe(1);
  });

  it("settles queued work as aborted without invoking it", async () => {
    const release = deferred();
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const queuedRun = vi.fn().mockResolvedValue("queued");
    const scheduler = createLidarrScheduler(
      createPolicy({ lanes: { "local-only": { concurrency: 1 } } }),
    );
    const run = scheduler.runBatch(
      "local-only",
      [
        task("running", async ({ signal }) => {
          receivedSignal = signal;
          await release.promise;
          return "running";
        }),
        task("queued", queuedRun),
      ],
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(receivedSignal).toBe(controller.signal));

    controller.abort();
    release.resolve();
    const result = await run;
    expect(queuedRun).not.toHaveBeenCalled();
    expect(result.results[1]).toMatchObject({ outcome: "skipped", failureType: "aborted" });
  });

  it("rethrows the original object and attaches safe execution metadata", async () => {
    const apiKey = "super-secret-api-key";
    const failure = new LidarrUnreachableError("status", `failed with ${apiKey}`);
    const scheduler = createLidarrScheduler(createPolicy(), {
      delay: vi.fn().mockResolvedValue(undefined),
      random: () => 0,
    });

    let thrown: unknown;
    try {
      await scheduler.runSingle(
        "local-only",
        task("status", async () => {
          throw failure;
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(failure);
    const metadata = readLidarrExecutionMetadata(thrown);
    expect(metadata).toMatchObject({
      taskId: "status",
      lane: "local-only",
      outcome: "failed",
      attempts: 2,
      failureType: "lidarr-unreachable",
    });
    expect(JSON.stringify(metadata)).not.toContain(apiKey);
  });
});
