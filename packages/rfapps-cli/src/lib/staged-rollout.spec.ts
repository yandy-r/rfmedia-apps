import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  executeStagedRollout,
  formatStagedEvent,
  formatStagedSummary,
  planStagedBatches,
  type ExecuteStagedRolloutDeps,
  type StagedPhaseOperation,
  type StagedRunPhaseResult,
} from "./staged-rollout.js";

import type { DependencyGraph, ExecutionPhase } from "../types/parallel.js";
import type {
  StagedBatch,
  StagedBatchFailed,
  StagedBatchOutcome,
  StagedBatchPassed,
  StagedGateReport,
  StagedRolloutEvent,
} from "../types/staged.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a DependencyGraph from phases and an optional per-service dependency map. */
function graph(
  phases: ExecutionPhase[],
  dependencyMap?: Record<string, string[]>,
): DependencyGraph {
  return {
    phases,
    hasCycles: false,
    ...(dependencyMap === undefined
      ? {}
      : { dependencyMap: new Map(Object.entries(dependencyMap)) }),
  };
}

/** A gate report where every started service is ready. */
function readyGate(started: string[]): StagedGateReport {
  return {
    ready: true,
    timedOut: false,
    degraded: false,
    elapsedMs: 10,
    attempts: 1,
    services: started.map((service) => ({
      service,
      status: "ready",
      reason: "ready",
      assurance: "healthcheck",
      stableForMs: 0,
    })),
  };
}

type RunPhaseInput = {
  operation: StagedPhaseOperation;
  batch: StagedBatch;
  phases: ExecutionPhase[];
};

/** Narrow an outcome to `passed`, failing loudly instead of silently skipping assertions. */
function passedOutcome(outcome: StagedBatchOutcome | undefined): StagedBatchPassed {
  if (outcome?.status !== "passed") {
    throw new Error(`expected a passed batch outcome, received: ${outcome?.status ?? "none"}`);
  }
  return outcome;
}

/** Narrow an outcome to `failed`, failing loudly instead of silently skipping assertions. */
function failedOutcome(outcome: StagedBatchOutcome | undefined): StagedBatchFailed {
  if (outcome?.status !== "failed") {
    throw new Error(`expected a failed batch outcome, received: ${outcome?.status ?? "none"}`);
  }
  return outcome;
}

describe("planStagedBatches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  interface PhaseShape {
    name: string;
    phases: ExecutionPhase[];
    dependencyMap: Record<string, string[]>;
  }

  const phaseShapes: PhaseShape[] = [
    {
      name: "infra-stack",
      phases: [
        {
          phase: 0,
          services: [
            "cloudflared",
            "docktail",
            "forgejo-postgres",
            "homarr",
            "ofelia",
            "speedtest-tracker",
            "stirling-pdf",
            "traefik",
            "uptime-kuma",
          ],
          dependsOn: [],
        },
        { phase: 1, services: ["forgejo"], dependsOn: ["forgejo-postgres"] },
        {
          phase: 2,
          services: [
            "forgejo-itcn-runner",
            "forgejo-runner",
            "forgejo-runner-2",
            "forgejo-runner-3",
          ],
          dependsOn: ["forgejo"],
        },
      ],
      dependencyMap: {
        forgejo: ["forgejo-postgres"],
        "forgejo-itcn-runner": ["forgejo"],
        "forgejo-runner": ["forgejo"],
        "forgejo-runner-2": ["forgejo"],
        "forgejo-runner-3": ["forgejo"],
      },
    },
    {
      name: "chained app",
      phases: [
        { phase: 0, services: ["cache", "db"], dependsOn: [] },
        { phase: 1, services: ["api"], dependsOn: ["cache", "db"] },
        { phase: 2, services: ["web"], dependsOn: ["api"] },
      ],
      dependencyMap: { api: ["cache", "db"], web: ["api"] },
    },
  ];

  const t1Cases = phaseShapes.flatMap((shape) =>
    [1, 2, 3, 99].map((batchSize) => ({ name: shape.name, batchSize, shape })),
  );

  it.each(t1Cases)(
    "never places a service in an earlier batch than its dependency ($name, batch size $batchSize)",
    ({ shape, batchSize }) => {
      const plan = planStagedBatches({
        graph: graph(shape.phases, shape.dependencyMap),
        batchSize,
        onFailure: "halt",
        profileMapping: { traefik: "core" },
      });

      const batchIndexOf = (service: string): number => {
        const batch = plan.batches.find((candidate) => candidate.services.includes(service));
        if (batch === undefined) {
          throw new Error(`${service} was not planned into any batch`);
        }
        return batch.index;
      };
      const batchAt = (index: number): StagedBatch => {
        const batch = plan.batches[index - 1];
        if (batch === undefined) {
          throw new Error(`no batch at index ${index}`);
        }
        return batch;
      };
      const phaseNumberOf = (batch: StagedBatch, service: string): number => {
        const phase = batch.phases.find((candidate) => candidate.services.includes(service));
        if (phase === undefined) {
          throw new Error(`${service} is missing from batch ${batch.index} phase slice`);
        }
        return phase.phase;
      };

      // A dependency is never started after the service that depends on it.
      for (const [service, dependencies] of Object.entries(shape.dependencyMap)) {
        for (const dependency of dependencies) {
          const serviceBatch = batchIndexOf(service);
          const dependencyBatch = batchIndexOf(dependency);
          expect(dependencyBatch).toBeLessThanOrEqual(serviceBatch);
          if (dependencyBatch === serviceBatch) {
            const batch = batchAt(serviceBatch);
            expect(phaseNumberOf(batch, dependency)).toBeLessThan(phaseNumberOf(batch, service));
          }
        }
      }

      // Phase numbers, dependsOn and per-phase source order survive the slice.
      for (const batch of plan.batches) {
        for (const phase of batch.phases) {
          const source = shape.phases.find((candidate) => candidate.phase === phase.phase);
          expect(source).toBeDefined();
          expect(phase.dependsOn).toEqual(source?.dependsOn);
          expect(phase.services).toEqual(
            source?.services.filter((service) => batch.services.includes(service)),
          );
        }
      }

      // Every service is planned exactly once.
      const allServices = shape.phases.flatMap((phase) => phase.services);
      expect([...plan.batches.flatMap((batch) => batch.services)].sort()).toEqual(
        [...allServices].sort(),
      );
      expect(plan.totalServices).toBe(allServices.length);

      // A batch large enough to hold everything reproduces the source phases exactly.
      if (batchSize >= allServices.length) {
        expect(plan.batches).toHaveLength(1);
        expect(batchAt(1).phases).toEqual(shape.phases);
      }
    },
  );

  it("orders core-profile services last within a phase", () => {
    const coreLast = planStagedBatches({
      graph: graph([{ phase: 0, services: ["traefik", "uptime-kuma"], dependsOn: [] }]),
      batchSize: 1,
      onFailure: "halt",
      profileMapping: { traefik: "core", "uptime-kuma": "infrastructure" },
    });

    expect(coreLast.batches.map((batch) => batch.services)).toEqual([["uptime-kuma"], ["traefik"]]);

    // Remaining ties break on fan-in first, then on name.
    const tieBreaks = planStagedBatches({
      graph: graph(
        [
          {
            phase: 0,
            services: ["traefik", "uptime-kuma", "forgejo-postgres", "homarr"],
            dependsOn: [],
          },
          { phase: 1, services: ["forgejo"], dependsOn: ["forgejo-postgres"] },
        ],
        { forgejo: ["forgejo-postgres"] },
      ),
      batchSize: 99,
      onFailure: "halt",
      profileMapping: { traefik: "core", "uptime-kuma": "infrastructure" },
    });

    expect(tieBreaks.batches[0]?.services).toEqual([
      // fan-in 0, alphabetical
      "homarr",
      "uptime-kuma",
      // fan-in 1 sorts after every zero-fan-in service despite its name
      "forgejo-postgres",
      // core sorts last within its phase
      "traefik",
      // later phases always follow
      "forgejo",
    ]);
  });
});

describe("executeStagedRollout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const chainPhases: ExecutionPhase[] = [
    { phase: 0, services: ["db", "cache", "traefik"], dependsOn: [] },
    { phase: 1, services: ["api"], dependsOn: ["db"] },
    { phase: 2, services: ["web"], dependsOn: ["api"] },
  ];
  const chainDependencies = { api: ["db"], web: ["api"] };

  it.each(["halt", "continue"] as const)(
    "halts remaining batches without Docker calls; continue attempts every batch",
    async (policy) => {
      const plan = planStagedBatches({
        graph: graph(chainPhases, chainDependencies),
        batchSize: 1,
        onFailure: policy,
        profileMapping: { traefik: "core" },
      });
      expect(plan.batches.map((batch) => batch.services)).toEqual([
        ["cache"],
        ["db"],
        ["traefik"],
        ["api"],
        ["web"],
      ]);

      const runPhase = vi.fn(async ({ phases }: RunPhaseInput): Promise<StagedRunPhaseResult> => {
        const services = phases.flatMap((phase) => phase.services);
        return services.includes("db")
          ? { succeeded: [], failed: [{ name: "db", error: "start failed" }] }
          : { succeeded: services, failed: [] };
      });
      const gate = vi.fn(async ({ started }: { started: string[] }) => readyGate(started));

      const report = await executeStagedRollout(
        {
          plan,
          dependencyMap: new Map(Object.entries(chainDependencies)),
          skipPull: true,
        },
        { runPhase, gate } satisfies ExecuteStagedRolloutDeps,
      );

      const dockerBatches = runPhase.mock.calls.map(([input]) => input.batch.index);

      if (policy === "halt") {
        expect(dockerBatches).toEqual([1, 2]);
        expect(gate).toHaveBeenCalledTimes(1);
        expect(report.status).toBe("halted");
        expect(report.haltedAtBatch).toBe(2);
        expect(report.batches.slice(2).map((outcome) => outcome.status)).toEqual([
          "skipped",
          "skipped",
          "skipped",
        ]);
        expect(report.healthy).toEqual(["cache"]);

        const notAttempted = report.failed.filter(
          (failure) => failure.code === "STAGE_NOT_ATTEMPTED",
        );
        expect(notAttempted.map((failure) => failure.name)).toEqual(["traefik", "api", "web"]);
        for (const failure of notAttempted) {
          expect(failure.error).toMatch(/^Not attempted: staged rollout halted after batch /);
          expect(failure.error).toBe("Not attempted: staged rollout halted after batch 2 of 5");
        }

        // The summary partitions the FULL ledger: a batch that failed purely at
        // `start-failed` has no unhealthy services, so `db` must still be counted,
        // investigated and resumed rather than silently dropped.
        const summary = formatStagedSummary(report).join("\n");
        expect(summary).toMatch(/^HALTED after batch 2 of 5\n/);
        expect(summary).toMatch(/healthy: +1 {2}\(cache\)/);
        expect(summary).toMatch(/failed to start: +1 {2}\(db\)/);
        expect(summary).toMatch(/not attempted: +3 {2}\(traefik, api, web\)/);
        expect(summary).not.toMatch(/unhealthy:/);
        expect(summary).toContain("Investigate:  rfapps logs -s db");
        expect(summary).toContain(
          "rfapps deploy --services db,traefik,api,web --staged --batch-size 1",
        );
        return;
      }

      // "continue": batch 3 is still attempted after batch 2 failed.
      expect(dockerBatches).toEqual([1, 2, 3]);
      expect(report.status).toBe("degraded");
      expect(report.haltedAtBatch).toBeUndefined();
      expect(report.batches.some((outcome) => outcome.status === "skipped")).toBe(false);
      expect(report.failed.filter((failure) => failure.code === "STAGE_NOT_ATTEMPTED")).toEqual([]);
      expect(report.healthy).toEqual(["cache", "traefik"]);

      // Dependents of the batch-2 failure are recorded, proving the rollout-level
      // failure set survives across batches.
      expect(
        report.failed
          .filter((failure) => failure.code === "STAGE_DEPENDENCY_SKIPPED")
          .map((failure) => failure.name),
      ).toEqual(["api", "web"]);
    },
  );

  it("degraded telemetry never halts", async () => {
    const plan = planStagedBatches({
      graph: graph([{ phase: 0, services: ["a", "b"], dependsOn: [] }]),
      batchSize: 1,
      onFailure: "halt",
      profileMapping: {},
    });

    const runPhase = vi.fn(
      async ({ phases }: RunPhaseInput): Promise<StagedRunPhaseResult> => ({
        succeeded: phases.flatMap((phase) => phase.services),
        failed: [],
      }),
    );
    const gate = vi.fn(
      async ({ started }: { started: string[] }): Promise<StagedGateReport> =>
        started.includes("a")
          ? {
              ready: false,
              timedOut: true,
              degraded: true,
              elapsedMs: 1000,
              attempts: 2,
              services: [
                {
                  service: "a",
                  status: "pending",
                  reason: "telemetry-unavailable",
                  assurance: "healthcheck",
                  stableForMs: 0,
                },
              ],
            }
          : readyGate(started),
    );
    const events: StagedRolloutEvent[] = [];

    const report = await executeStagedRollout(
      {
        plan,
        skipPull: true,
        onEvent: (event) => {
          events.push(event);
        },
      },
      { runPhase, gate } satisfies ExecuteStagedRolloutDeps,
    );

    const first = passedOutcome(report.batches[0]);
    expect(first.started).toEqual(["a"]);
    expect(first.gate?.degraded).toBe(true);
    expect(first.failed).toEqual([]);

    expect(report.status).toBe("completed");
    expect(report.haltedAtBatch).toBeUndefined();
    expect(report.unhealthy).toEqual([]);
    expect(report.healthy).toEqual(["a", "b"]);
    expect(events.some((event) => event.kind === "gate-degraded")).toBe(true);

    // Every subsequent batch still runs.
    expect(runPhase.mock.calls.map(([input]) => input.batch.index)).toEqual([1, 2]);
    expect(gate).toHaveBeenCalledTimes(2);
    expect(passedOutcome(report.batches[1]).started).toEqual(["b"]);
  });

  // The degraded bypass is the inverse of T4 and needs its own case: T4 proves a
  // missing signal does not halt, this proves the bypass is narrow enough that a
  // service unready for an unrelated reason is not laundered into a pass.
  it("fails a degraded batch when a service is unready for a non-telemetry reason", async () => {
    const plan = planStagedBatches({
      graph: graph([{ phase: 0, services: ["a", "b"], dependsOn: [] }]),
      batchSize: 1,
      onFailure: "halt",
      profileMapping: {},
    });

    const runPhase = vi.fn(
      async ({ phases }: RunPhaseInput): Promise<StagedRunPhaseResult> => ({
        succeeded: phases.flatMap((phase) => phase.services),
        failed: [],
      }),
    );
    const gate = vi.fn(
      async (): Promise<StagedGateReport> => ({
        ready: false,
        timedOut: true,
        degraded: true,
        elapsedMs: 60_000,
        attempts: 12,
        services: [
          {
            service: "a",
            status: "pending",
            reason: "not-running",
            assurance: "healthcheck",
            stableForMs: 0,
          },
        ],
      }),
    );
    const events: StagedRolloutEvent[] = [];

    const report = await executeStagedRollout(
      {
        plan,
        skipPull: true,
        onEvent: (event) => {
          events.push(event);
        },
      },
      { runPhase, gate } satisfies ExecuteStagedRolloutDeps,
    );

    const first = failedOutcome(report.batches[0]);
    expect(first.cause).toBe("gate-timeout");
    expect(first.unhealthy).toEqual(["a"]);
    expect(report.status).toBe("halted");
    expect(report.haltedAtBatch).toBe(1);
    expect(report.healthy).toEqual([]);
    expect(runPhase.mock.calls.map(([input]) => input.batch.index)).toEqual([1]);
    expect(report.failed.map((failure) => failure.code)).toEqual([
      "STAGE_GATE_FAILED",
      "STAGE_NOT_ATTEMPTED",
    ]);

    // `failed` already carries a gate entry for every unhealthy service, so the
    // rendered line must not name `a` twice.
    const batchFailed = events.find((event) => event.kind === "batch-failed");
    expect(batchFailed).toBeDefined();
    expect(batchFailed && formatStagedEvent(batchFailed).message).toMatch(
      /^Batch 1: FAILED \(gate-timeout\) after \d+s: a$/,
    );
  });

  // Guards the orphan-cleanup scope: the injected runner reports its own
  // intra-batch dependency skips in `failed` with no distinguishing code, and
  // `attempted` drives `up -d --remove-orphans <list>` in the caller.
  it("keeps attempted limited to services a start was issued for", async () => {
    const plan = planStagedBatches({
      graph: graph(
        [
          { phase: 0, services: ["db"], dependsOn: [] },
          { phase: 1, services: ["api"], dependsOn: ["db"] },
        ],
        { api: ["db"] },
      ),
      batchSize: 2,
      onFailure: "continue",
      profileMapping: {},
    });
    expect(plan.batches.map((batch) => batch.services)).toEqual([["db", "api"]]);

    // Mirrors executeParallelPhases: `db` genuinely failed `up`, `api` was never
    // issued because its dependency failed in an earlier phase of the same batch.
    const runPhase = vi.fn(
      async (): Promise<StagedRunPhaseResult> => ({
        succeeded: [],
        failed: [
          { name: "db", error: "start failed" },
          { name: "api", error: "Skipped: dependency failed in prior phase" },
        ],
      }),
    );

    const report = await executeStagedRollout(
      { plan, dependencyMap: new Map([["api", ["db"]]]), skipPull: true },
      { runPhase } satisfies ExecuteStagedRolloutDeps,
    );

    expect(report.attempted).toEqual(["db"]);
    expect(report.healthy).toEqual([]);
    expect(failedOutcome(report.batches[0]).cause).toBe("start-failed");
  });
});
