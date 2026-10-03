import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../actions/status.js", () => ({
  executeStatus: vi.fn(),
}));
vi.mock("../actions/pull.js", () => ({
  executePull: vi.fn(),
}));
vi.mock("../actions/deploy.js", () => ({
  executeDeploy: vi.fn(),
}));
vi.mock("../actions/health.js", () => ({
  executeHealth: vi.fn(),
}));
vi.mock("../actions/rebuild.js", () => ({
  executeRebuild: vi.fn(),
}));
vi.mock("../actions/stop.js", () => ({
  executeStop: vi.fn(),
}));
vi.mock("../actions/delete.js", () => ({
  executeDelete: vi.fn(),
}));
vi.mock("../actions/prune.js", () => ({
  executePrune: vi.fn(),
}));
vi.mock("../actions/plan.js", () => ({
  executePlan: vi.fn(),
}));
vi.mock("../actions/apply.js", () => ({
  executeApply: vi.fn(),
}));
vi.mock("../actions/history.js", () => ({
  executeHistory: vi.fn(),
}));
vi.mock("../actions/rollback.js", () => ({
  executeRollback: vi.fn(),
}));
vi.mock("../actions/drift.js", () => ({
  executeDriftDetect: vi.fn(),
  executeDriftShow: vi.fn(),
  executeDriftImport: vi.fn(),
}));
vi.mock("../actions/reconcile.js", () => ({
  executeReconcile: vi.fn(),
}));

import { executeStatus } from "../actions/status.js";
import { executeRollback } from "../actions/rollback.js";
import { executeDriftDetect, executeDriftShow } from "../actions/drift.js";
import { executeReconcile } from "../actions/reconcile.js";
import { formatOutput } from "../lib/formatters/index.js";
import type { ReconcileResult } from "../types/index.js";
import { RECONCILE_SCHEMA_VERSION } from "../types/index.js";

import {
  invokeDriftDetect,
  invokeDriftReconcile,
  invokeDriftShow,
  invokeRollback,
  invokeStatus,
  RfappsMcpAdapterError,
} from "./adapters.js";

function makeReconcileResult(overrides: Partial<ReconcileResult> = {}): ReconcileResult {
  return {
    schemaVersion: RECONCILE_SCHEMA_VERSION,
    operation: "reconcile",
    mode: "report",
    dryRun: false,
    status: "reported",
    scope: {
      composePath: "/srv/apps/compose.yml",
      project: "rfmedia-apps",
      profiles: ["media"],
      services: ["plex"],
    },
    actionFingerprint: "sha256:reviewed-actions",
    automation: { status: "not_requested" },
    services: [
      {
        service: "plex",
        comparison: "drifted",
        drift: {
          hasDrift: true,
          direction: "compose_ahead",
          categories: ["environment"],
          image: { changed: false },
          environment: [{ name: "PLEX_TOKEN", changeType: "modified" }],
          ports: { changed: false },
          volumes: { changed: false },
          networks: { changed: false },
          runtimeStatus: {
            changed: false,
            currentState: "running",
            currentHealth: "healthy",
            desiredState: "running",
            desiredHealth: "healthy",
          },
        },
        action: {
          kind: "recreate",
          categories: ["environment"],
          eligibility: "not_requested",
          reasons: [{ code: "RECONCILE_ENVIRONMENT_DRIFT", category: "environment" }],
        },
        outcome: "reported",
      },
    ],
    summary: {
      selected: 1,
      inSync: 0,
      drifted: 1,
      actionable: 1,
      blocked: 0,
      converged: 0,
      failed: 0,
    },
    success: true,
    exitCode: 0,
    ...overrides,
  };
}

describe("rfapps MCP adapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it("captures JSON action output and returns parsed payload", async () => {
    vi.mocked(executeStatus).mockImplementation(async () => {
      await formatOutput("json", {
        timestamp: "2026-01-01T00:00:00.000Z",
        services: [],
        total: 0,
        running: 0,
        healthy: 0,
      });
    });

    const result = await invokeStatus({ service: "traefik" });

    expect(result).toMatchObject({
      total: 0,
      running: 0,
      healthy: 0,
    });
    expect(executeStatus).toHaveBeenCalledOnce();
  });

  it("does not forward yes when MCP caller does not opt in", async () => {
    vi.mocked(executeStatus).mockImplementation(async () => {
      await formatOutput("json", {
        timestamp: "2026-01-01T00:00:00.000Z",
        services: [],
        total: 0,
        running: 0,
        healthy: 0,
      });
    });

    await invokeStatus({ service: "traefik" });

    const globalOptions = vi.mocked(executeStatus).mock.calls[0]?.[1];
    expect(globalOptions).toBeDefined();
    expect(globalOptions).not.toHaveProperty("yes");
  });

  it("forwards yes when MCP caller explicitly opts in", async () => {
    vi.mocked(executeStatus).mockImplementation(async () => {
      await formatOutput("json", {
        timestamp: "2026-01-01T00:00:00.000Z",
        services: [],
        total: 0,
        running: 0,
        healthy: 0,
      });
    });

    await invokeStatus({ service: "traefik", yes: true });

    const globalOptions = vi.mocked(executeStatus).mock.calls[0]?.[1];
    expect(globalOptions).toBeDefined();
    expect(globalOptions).toMatchObject({ yes: true });
  });

  it("normalizes thrown errors into adapter errors", async () => {
    vi.mocked(executeStatus).mockRejectedValue(new Error("boom"));

    await expect(invokeStatus({ service: "traefik" })).rejects.toBeInstanceOf(
      RfappsMcpAdapterError,
    );

    try {
      await invokeStatus({ service: "traefik" });
    } catch (error) {
      expect(error).toBeInstanceOf(RfappsMcpAdapterError);
      const adapterError = error as RfappsMcpAdapterError;
      expect(adapterError.envelope).toMatchObject({
        code: "ERROR",
        message: "boom",
      });
    }
  });

  it("treats non-zero exit code as adapter failure", async () => {
    vi.mocked(executeStatus).mockImplementation(async () => {
      process.exitCode = 1;
      await formatOutput("json", { error: "status failed" });
    });

    await expect(invokeStatus({ service: "traefik" })).rejects.toBeInstanceOf(
      RfappsMcpAdapterError,
    );
  });

  it("isolates structured output across concurrent adapter calls", async () => {
    vi.mocked(executeStatus).mockImplementation(async (options) => {
      const delayMs = options.service === "svc-a" ? 20 : 0;
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      await formatOutput("json", {
        timestamp: "2026-01-01T00:00:00.000Z",
        services: [],
        total: options.service === "svc-a" ? 1 : 2,
        running: 0,
        healthy: 0,
      });
    });

    const [resultA, resultB] = await Promise.all([
      invokeStatus({ service: "svc-a" }),
      invokeStatus({ service: "svc-b" }),
    ]);

    expect(resultA).toMatchObject({ total: 1 });
    expect(resultB).toMatchObject({ total: 2 });
  });

  it("returns dryRun fallback when an action emits no machine output", async () => {
    vi.mocked(executeStatus).mockResolvedValue(undefined);

    const result = await invokeStatus({
      service: "traefik",
      dryRun: true,
    });

    expect(result).toEqual({ dryRun: true });
  });

  it("delegates drift reconcile to the shared action with explicit authorization", async () => {
    const expected = makeReconcileResult({
      mode: "auto-apply",
      automation: { status: "allowed" },
    });
    vi.mocked(executeReconcile).mockImplementation(async () => {
      await formatOutput("json", expected);
    });

    const result = await invokeDriftReconcile({
      services: ["plex", "tautulli"],
      group: "media-stack",
      noSidecars: true,
      autoApply: true,
      yes: true,
      showUnchanged: true,
      healthTimeout: 45,
      compose: "/srv/apps/compose.yml",
      envFile: "/srv/apps/.env",
      profile: "media",
      verbose: true,
    });

    expect(executeReconcile).toHaveBeenCalledWith(
      {
        service: undefined,
        services: "plex,tautulli",
        group: "media-stack",
        sidecars: false,
        autoApply: true,
        showUnchanged: true,
        healthTimeout: 45,
        compose: "/srv/apps/compose.yml",
        envFile: "/srv/apps/.env",
        profile: "media",
      },
      expect.objectContaining({
        json: true,
        output: "json",
        yes: true,
        verbose: true,
      }),
    );
    expect(result).toEqual(expected);
  });

  it("returns the complete dry-run document instead of a generic fallback", async () => {
    const expected = makeReconcileResult({
      mode: "auto-apply",
      dryRun: true,
      status: "planned",
    });
    vi.mocked(executeReconcile).mockImplementation(async () => {
      await formatOutput("json", expected);
    });

    const result = await invokeDriftReconcile({
      autoApply: true,
      yes: true,
      dryRun: true,
    });

    expect(result).toEqual(expected);
    expect(result).not.toEqual({ dryRun: true });
    expect(executeReconcile).toHaveBeenCalledWith(
      expect.objectContaining({ autoApply: true }),
      expect.objectContaining({ dryRun: true, yes: true }),
    );
  });

  it("rejects auto-apply when explicit MCP confirmation is absent", async () => {
    const unauthorized = { autoApply: true } as unknown as Parameters<
      typeof invokeDriftReconcile
    >[0];

    await expect(invokeDriftReconcile(unauthorized)).rejects.toBeInstanceOf(RfappsMcpAdapterError);

    expect(executeReconcile).not.toHaveBeenCalled();
  });

  it("rejects reconciliation capture failures and missing documents", async () => {
    process.exitCode = 7;
    vi.mocked(executeReconcile).mockRejectedValueOnce(new Error("capture failed"));
    await expect(invokeDriftReconcile({})).rejects.toBeInstanceOf(RfappsMcpAdapterError);
    expect(process.exitCode).toBe(7);

    vi.mocked(executeReconcile).mockResolvedValueOnce(undefined);
    await expect(invokeDriftReconcile({})).rejects.toMatchObject({
      envelope: { message: "rfapps action produced no JSON output" },
    });
    expect(process.exitCode).toBe(7);
  });

  it("preserves the full structured result, redaction boundary, and prior exit state", async () => {
    const expected = makeReconcileResult({
      mode: "auto-apply",
      status: "partial",
      success: false,
      exitCode: 3,
    });
    vi.mocked(executeReconcile).mockImplementation(async () => {
      await formatOutput("json", expected);
      process.exitCode = expected.exitCode;
    });
    process.exitCode = 9;

    const result = await invokeDriftReconcile({
      autoApply: true,
      yes: true,
      useDotenvx: "/private/secrets.env",
    });

    expect(result).toEqual(expected);
    expect(process.exitCode).toBe(9);
    expect(JSON.stringify(result)).toContain("PLEX_TOKEN");
    expect(JSON.stringify(result)).not.toContain("/private/secrets.env");
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
  });

  it("passes report-only through drift detect while preserving service array translation", async () => {
    vi.mocked(executeDriftDetect).mockImplementation(async () => {
      await formatOutput("json", {
        schemaVersion: "1.0.0",
        timestamp: "2026-01-01T00:00:00.000Z",
        composePath: "compose.yml",
        services: [],
        summary: {
          total: 0,
          drifted: 0,
          unchanged: 0,
          directions: { composeAhead: 0, containerAhead: 0, diverged: 0 },
        },
      });
    });

    await invokeDriftDetect({ services: ["plex", "sonarr"], reportOnly: true });

    expect(executeDriftDetect).toHaveBeenCalledWith(
      expect.objectContaining({
        services: "plex,sonarr",
        reportOnly: true,
      }),
      expect.objectContaining({ output: "json" }),
    );
  });

  it("passes generation and time restore targets through rollback", async () => {
    vi.mocked(executeRollback).mockImplementation(async () => {
      await formatOutput("json", {
        success: true,
        service: "traefik",
        targetDeploymentId: 42,
        targetGeneration: 5,
        restoredImageTag: "traefik:v3.0",
      });
    });

    const result = await invokeRollback({
      service: "traefik",
      toGeneration: 5,
      toTime: undefined,
      yes: true,
    });

    expect(executeRollback).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "traefik",
        toGeneration: "5",
        toTime: undefined,
      }),
      expect.objectContaining({ output: "json" }),
    );
    expect(result).toMatchObject({ targetGeneration: 5 });
  });

  it("passes report-only through drift show", async () => {
    vi.mocked(executeDriftShow).mockImplementation(async () => {
      await formatOutput("json", {
        service: "plex",
        drift: {
          service: "plex",
          hasDrift: false,
          direction: "compose_ahead",
          categories: [],
          image: { changed: false },
          environment: [],
          ports: { changed: false },
          volumes: { changed: false },
          networks: { changed: false },
          runtimeStatus: {
            current: { state: "running", health: "none" },
            desired: { state: "running", health: "none" },
            changed: false,
          },
        },
      });
    });

    await invokeDriftShow({ service: "plex", reportOnly: true });

    expect(executeDriftShow).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "plex",
        reportOnly: true,
      }),
      expect.objectContaining({ output: "json" }),
    );
  });
});
