import { describe, expect, it } from "vitest";

import { McpSchemaValidationError } from "@rfmedia/common";

import type { ComposeServiceConfig } from "../lib/docker.js";
import { buildPlanIntelligence } from "../lib/plan-intelligence.js";
import type {
  ChangeDimension,
  PlanBaselineResult,
  PlanProvenance,
  ReconcileAutomationDecision,
  ReconcileDriftProjection,
  ReconcileOutcome,
  ReconcileResult,
  ServiceChange,
} from "../types/index.js";
import {
  RECONCILE_MAX_SERVICES,
  RECONCILE_MAX_SERVICE_NAME_LENGTH,
  RECONCILE_SCHEMA_VERSION,
} from "../types/index.js";
import { rfappsMcpSchemas } from "./schema.js";

function makePlanOutput(
  image: Record<string, unknown> = { changed: false },
  intent?: "deployment" | "managed-update",
) {
  return {
    planPath: "/tmp/rfapps-plan.json",
    plan: {
      ...(intent === undefined ? {} : { intent }),
      id: "plan-1",
      createdAt: "2026-07-17T00:00:00.000Z",
      composeHash: "compose-hash",
      composePath: "compose.yml",
      services: [
        {
          service: "plex",
          changeType: "unchanged",
          image,
          environment: [],
          ports: { changed: false },
          volumes: { changed: false },
          networks: { changed: false },
        },
      ],
      summary: {
        toCreate: 0,
        toUpdate: 0,
        toRecreate: 0,
        toDelete: 0,
        unchanged: 1,
        updatesAvailable: 0,
        total: 1,
      },
    },
  };
}

function makeReconcileDrift(
  overrides: Partial<ReconcileDriftProjection> = {},
): ReconcileDriftProjection {
  return {
    hasDrift: true,
    direction: "compose_ahead",
    categories: ["runtime-status"],
    image: { changed: false },
    environment: [],
    ports: { changed: false },
    volumes: { changed: false },
    networks: { changed: false },
    runtimeStatus: {
      changed: true,
      currentState: "exited",
      currentHealth: "none",
      desiredState: "running",
      desiredHealth: "healthy",
    },
    ...overrides,
  };
}

function makeReconcileOutput(
  automation: ReconcileAutomationDecision = { status: "allowed" },
): ReconcileResult {
  const finalDrift = makeReconcileDrift({
    hasDrift: false,
    categories: [],
    runtimeStatus: {
      changed: false,
      currentState: "running",
      currentHealth: "healthy",
      desiredState: "running",
      desiredHealth: "healthy",
    },
  });

  return {
    schemaVersion: RECONCILE_SCHEMA_VERSION,
    operation: "reconcile",
    mode: "auto-apply",
    dryRun: false,
    status: "partial",
    scope: {
      composePath: "/srv/apps/compose.yml",
      project: "rfmedia-apps",
      profiles: ["media"],
      services: [
        "already-ready",
        "create-me",
        "recreate-me",
        "scaled",
        "start-me",
        "window-blocked",
      ],
    },
    actionFingerprint: "sha256:reviewed-actions",
    automation,
    services: [
      {
        service: "already-ready",
        comparison: "in_sync",
        drift: finalDrift,
        action: {
          kind: "none",
          categories: [],
          eligibility: "not_requested",
          reasons: [],
        },
        outcome: "no_action",
      },
      {
        service: "create-me",
        comparison: "drifted",
        drift: makeReconcileDrift({
          runtimeStatus: {
            changed: true,
            currentState: "missing",
            currentHealth: "unknown",
            desiredState: "running",
            desiredHealth: "healthy",
          },
        }),
        action: {
          kind: "create",
          categories: ["runtime-status"],
          eligibility: "allowed",
          reasons: [{ code: "RECONCILE_CONTAINER_MISSING", category: "runtime-status" }],
        },
        outcome: "reported",
      },
      {
        service: "recreate-me",
        comparison: "drifted",
        drift: makeReconcileDrift({
          categories: ["image", "environment"],
          image: { changed: true },
          environment: [{ name: "PLEX_TOKEN", changeType: "modified" }],
        }),
        action: {
          kind: "recreate",
          categories: ["image", "environment"],
          eligibility: "not_requested",
          reasons: [
            { code: "RECONCILE_IMAGE_DRIFT", category: "image" },
            { code: "RECONCILE_ENVIRONMENT_DRIFT", category: "environment" },
          ],
        },
        outcome: "action_failed",
      },
      {
        service: "scaled",
        comparison: "observation_failed",
        drift: makeReconcileDrift(),
        action: {
          kind: "blocked",
          categories: ["runtime-status"],
          eligibility: "blocked",
          reasons: [{ code: "RECONCILE_AMBIGUOUS_INSTANCES" }],
        },
        outcome: "observation_failed",
      },
      {
        service: "start-me",
        comparison: "drifted",
        drift: makeReconcileDrift(),
        action: {
          kind: "start",
          categories: ["runtime-status"],
          eligibility: "allowed",
          reasons: [{ code: "RECONCILE_CONTAINER_STOPPED", category: "runtime-status" }],
        },
        outcome: "converged",
        finalDrift,
      },
      {
        service: "window-blocked",
        comparison: "drifted",
        drift: makeReconcileDrift(),
        action: {
          kind: "blocked",
          proposedKind: "start",
          categories: ["runtime-status"],
          eligibility: "blocked",
          reasons: [{ code: "OUTSIDE_MAINTENANCE_WINDOW" }],
        },
        outcome: "blocked_policy",
      },
    ],
    summary: {
      selected: 6,
      inSync: 1,
      drifted: 4,
      actionable: 3,
      blocked: 2,
      converged: 1,
      failed: 2,
    },
    success: false,
    exitCode: 3,
  };
}

describe("rfapps MCP schemas", () => {
  it("accepts valid status tool arguments", () => {
    const parsed = rfappsMcpSchemas.status.input.parse({
      service: "traefik",
      stats: true,
      dryRun: false,
    });

    expect(parsed).toMatchObject({
      service: "traefik",
      stats: true,
      dryRun: false,
    });
  });

  it("accepts health tool arguments", () => {
    const parsed = rfappsMcpSchemas.health.input.parse({
      service: "traefik",
      waitForReady: true,
      healthTimeout: 45,
    });

    expect(parsed).toMatchObject({
      service: "traefik",
      waitForReady: true,
      healthTimeout: 45,
    });
  });

  it("rejects invalid status arguments with deterministic details", () => {
    expect(() =>
      rfappsMcpSchemas.status.input.parse({
        services: "traefik",
      }),
    ).toThrowError(McpSchemaValidationError);

    try {
      rfappsMcpSchemas.status.input.parse({ services: "traefik" });
    } catch (error) {
      expect(error).toBeInstanceOf(McpSchemaValidationError);
      const validationError = error as McpSchemaValidationError;
      expect(validationError.issues[0]).toMatchObject({
        path: "$.services",
        expected: "array",
      });
    }
  });

  it("rejects unsupported status fields that are not in the status CLI contract", () => {
    expect(() =>
      rfappsMcpSchemas.status.input.parse({
        group: "media-stack",
      }),
    ).toThrowError(McpSchemaValidationError);

    expect(() =>
      rfappsMcpSchemas.status.input.parse({
        noSidecars: true,
      }),
    ).toThrowError(McpSchemaValidationError);

    expect(() =>
      rfappsMcpSchemas.status.input.parse({
        profile: "core",
      }),
    ).toThrowError(McpSchemaValidationError);
  });

  it("validates drift-show output shape", () => {
    const parsed = rfappsMcpSchemas.driftShow.output.parse({
      service: "plex",
      drift: {
        service: "plex",
        hasDrift: true,
        direction: "diverged",
        categories: ["image", "runtime-status"],
        image: {
          current: "plex:old",
          desired: "plex:new",
          changed: true,
        },
        environment: [],
        ports: { changed: false },
        volumes: { changed: false },
        networks: { changed: false },
        runtimeStatus: {
          current: { state: "running", health: "unhealthy" },
          desired: { state: "running", health: "healthy" },
          changed: true,
        },
      },
    });

    expect(parsed).toMatchObject({
      service: "plex",
      drift: {
        hasDrift: true,
        direction: "diverged",
        categories: ["image", "runtime-status"],
      },
    });
  });

  it("validates versioned drift-detect output with runtime-status category", () => {
    const parsed = rfappsMcpSchemas.driftDetect.output.parse({
      schemaVersion: "1.0.0",
      timestamp: "2026-01-01T00:00:00.000Z",
      composePath: "compose.yml",
      services: [
        {
          service: "plex",
          hasDrift: true,
          direction: "compose_ahead",
          categories: ["runtime-status"],
          image: { changed: false },
          environment: [],
          ports: { changed: false },
          volumes: { changed: false },
          networks: { changed: false },
          runtimeStatus: {
            current: { state: "exited", health: "none" },
            desired: { state: "running", health: "none" },
            changed: true,
          },
        },
      ],
      summary: {
        total: 1,
        drifted: 1,
        unchanged: 0,
        directions: {
          composeAhead: 1,
          containerAhead: 0,
          diverged: 0,
        },
      },
    });

    expect(parsed).toMatchObject({
      schemaVersion: "1.0.0",
      services: [{ categories: ["runtime-status"] }],
    });
  });

  it("accepts report-only on read-only drift tools", () => {
    expect(
      rfappsMcpSchemas.driftDetect.input.parse({
        services: ["plex"],
        reportOnly: true,
      }),
    ).toMatchObject({ reportOnly: true });

    expect(
      rfappsMcpSchemas.driftShow.input.parse({
        service: "plex",
        reportOnly: true,
      }),
    ).toMatchObject({ reportOnly: true });
  });

  it("accepts the complete report-oriented reconciliation input", () => {
    const parsed = rfappsMcpSchemas.driftReconcile.input.parse({
      service: "plex",
      services: ["plex", "tautulli"],
      group: "media-stack",
      noSidecars: true,
      compose: "/srv/apps/compose.yml",
      envFile: "/srv/apps/.env",
      profile: "media",
      dryRun: true,
      debug: true,
      verbose: true,
      useDotenvx: "/srv/apps/.env",
      showUnchanged: true,
      healthTimeout: 60,
    });

    expect(parsed).toMatchObject({
      autoApply: undefined,
      dryRun: true,
      showUnchanged: true,
      healthTimeout: 60,
    });
  });

  it("requires explicit yes authorization for MCP auto-apply", () => {
    expect(
      rfappsMcpSchemas.driftReconcile.input.parse({ autoApply: true, yes: true }),
    ).toMatchObject({ autoApply: true, yes: true });

    expect(() => rfappsMcpSchemas.driftReconcile.input.parse({ autoApply: true })).toThrowError(
      McpSchemaValidationError,
    );
    expect(() =>
      rfappsMcpSchemas.driftReconcile.input.parse({ autoApply: true, yes: false }),
    ).toThrowError(McpSchemaValidationError);
  });

  it("rejects legacy or unknown reconciliation input fields", () => {
    expect(() => rfappsMcpSchemas.driftReconcile.input.parse({ reportOnly: true })).toThrowError(
      McpSchemaValidationError,
    );
    expect(() => rfappsMcpSchemas.driftReconcile.input.parse({ healthTimeout: 0 })).toThrowError(
      McpSchemaValidationError,
    );
  });

  it("rejects oversized reconciliation-only service scopes and names", () => {
    expect(() =>
      rfappsMcpSchemas.driftReconcile.input.parse({
        services: Array.from(
          { length: RECONCILE_MAX_SERVICES + 1 },
          (_, index) => `service-${index}`,
        ),
      }),
    ).toThrowError(McpSchemaValidationError);
    expect(() =>
      rfappsMcpSchemas.driftReconcile.input.parse({
        service: "s".repeat(RECONCILE_MAX_SERVICE_NAME_LENGTH + 1),
      }),
    ).toThrowError(McpSchemaValidationError);
    expect(() =>
      rfappsMcpSchemas.driftReconcile.input.parse({
        services: ["s".repeat(RECONCILE_MAX_SERVICE_NAME_LENGTH + 1)],
      }),
    ).toThrowError(McpSchemaValidationError);
  });

  it("validates every reconciliation action discriminator", () => {
    const result = makeReconcileOutput();
    const parsed = rfappsMcpSchemas.driftReconcile.output.parse(result);

    expect(parsed).toEqual(result);
    expect(parsed.services.map(({ action }) => action.kind)).toEqual([
      "none",
      "create",
      "recreate",
      "blocked",
      "start",
      "blocked",
    ]);
  });

  it("validates every reconciliation automation branch", () => {
    const cases: readonly ReconcileAutomationDecision[] = [
      { status: "not_requested" },
      { status: "allowed" },
      {
        status: "blocked",
        reasonCode: "OUTSIDE_MAINTENANCE_WINDOW",
        nextEligibleAt: "2026-07-18T02:00:00.000Z",
      },
    ];

    for (const automation of cases) {
      expect(
        rfappsMcpSchemas.driftReconcile.output.parse(makeReconcileOutput(automation)),
        automation.status,
      ).toEqual(makeReconcileOutput(automation));
    }
  });

  it("validates the complete reconciliation outcome vocabulary", () => {
    const outcomes: readonly ReconcileOutcome[] = [
      "reported",
      "no_action",
      "became_in_sync",
      "converged",
      "blocked_policy",
      "blocked_stale",
      "observation_failed",
      "action_failed",
      "not_converged",
      "cancelled_before_action",
      "cancelled_during_action",
      "skipped_after_unsafe_failure",
    ];

    for (const outcome of outcomes) {
      const result = makeReconcileOutput();
      result.services[0] = { ...result.services[0]!, outcome };

      expect(
        rfappsMcpSchemas.driftReconcile.output.parse(result).services[0]?.outcome,
        outcome,
      ).toBe(outcome);
    }
  });

  it("rejects incomplete, permissive, or secret-bearing reconciliation results", () => {
    const result = makeReconcileOutput();

    expect(() => rfappsMcpSchemas.driftReconcile.output.parse({ dryRun: true })).toThrowError(
      McpSchemaValidationError,
    );
    expect(() =>
      rfappsMcpSchemas.driftReconcile.output.parse({ ...result, schemaVersion: "1.0.0" }),
    ).toThrowError(McpSchemaValidationError);
    expect(() =>
      rfappsMcpSchemas.driftReconcile.output.parse({ ...result, timestamp: "not-allowed" }),
    ).toThrowError(McpSchemaValidationError);
    expect(() =>
      rfappsMcpSchemas.driftReconcile.output.parse({
        ...result,
        services: [
          {
            ...result.services[0],
            action: { ...result.services[0]!.action, eligibility: "allowed" },
          },
        ],
      }),
    ).toThrowError(McpSchemaValidationError);
    expect(() =>
      rfappsMcpSchemas.driftReconcile.output.parse({
        ...result,
        services: [
          {
            ...result.services[2],
            drift: {
              ...result.services[2]!.drift,
              environment: [
                { name: "PLEX_TOKEN", changeType: "modified", current: "secret-value" },
              ],
            },
          },
        ],
      }),
    ).toThrowError(McpSchemaValidationError);
  });

  it("allows dry-run payloads for mutation outputs", () => {
    const parsed = rfappsMcpSchemas.deploy.output.parse({
      dryRun: true,
      services: ["traefik"],
      composePath: "compose.yml",
    });

    expect(parsed).toMatchObject({
      dryRun: true,
    });
  });

  it("accepts strict rollback cleanup warnings", () => {
    const result = {
      success: true,
      service: "plex",
      targetDeploymentId: 7,
      warnings: [
        {
          code: "TEMP_OVERRIDE_CLEANUP_FAILED",
          message: "Temporary override cleanup requires operator attention",
          temporaryDirectory: "/private/rfapps-rollback-123",
        },
      ],
    };

    expect(rfappsMcpSchemas.rollback.output.parse(result)).toMatchObject(result);
    expect(() =>
      rfappsMcpSchemas.rollback.output.parse({
        ...result,
        warnings: [{ ...result.warnings[0], unexpected: true }],
      }),
    ).toThrowError(McpSchemaValidationError);
  });

  it("accepts legacy plan and history payloads without managed update fields", () => {
    expect(rfappsMcpSchemas.plan.output.parse(makePlanOutput())).toMatchObject({
      plan: {
        id: "plan-1",
        services: [{ image: { changed: false } }],
      },
    });

    expect(
      rfappsMcpSchemas.history.output.parse({
        entries: [
          {
            id: 1,
            timestamp: "2026-07-16T00:00:00.000Z",
            service: "plex",
            action: "deploy",
            status: "success",
          },
        ],
        totalCount: 1,
        filters: { limit: 10 },
      }),
    ).toMatchObject({ entries: [{ action: "deploy" }] });
  });

  it("round-trips a real buildPlanIntelligence payload through the plan output schema", () => {
    // A hand-written PlanIntelligence literal would defeat the point: McpSchema<T>
    // is covariant, so a schema omitting an optional field still satisfies the
    // _typeCheck anchor. Only a real builder output catches schema drift.
    const services: ServiceChange[] = [
      {
        service: "plex",
        resolvedConfigFingerprint: "a".repeat(64),
        changeType: "recreate",
        image: {
          current: "plexinc/pms-docker:1.40",
          desired: "plexinc/pms-docker:1.41",
          changed: true,
        },
        environment: [],
        ports: { changed: false },
        volumes: { changed: false },
        networks: { changed: false },
      },
    ];
    const composeServices: Record<string, ComposeServiceConfig> = {
      plex: { name: "plex" },
      tautulli: { name: "tautulli", depends_on: ["plex"] },
    };
    const decisiveByService = new Map<string, readonly ChangeDimension[]>([["plex", ["image"]]]);

    const arms: ReadonlyArray<{
      baselineArm: PlanProvenance["baseline"];
      baseline: PlanBaselineResult;
    }> = [
      { baselineArm: "none", baseline: { status: "unavailable", reason: "no-comparable-plan" } },
      {
        baselineArm: "previous-plan",
        baseline: {
          status: "loaded",
          baseline: {
            planId: "plan-baseline",
            createdAt: "2026-07-16T00:00:00.000Z",
            composeFileChanged: true,
            services: { plex: { resolvedConfigFingerprint: "b".repeat(64) } },
          },
        },
      },
    ];

    for (const { baselineArm, baseline } of arms) {
      const intelligence = buildPlanIntelligence({
        services,
        decisiveByService,
        composeServices,
        runningServices: new Set(["plex", "tautulli"]),
        runtimeStateObserved: true,
        registryChecked: false,
        profileMapping: { plex: "media", tautulli: "media" },
        baseline,
      });

      expect(intelligence.provenance.baseline, baselineArm).toBe(baselineArm);
      // Guards against a vacuous round-trip: the fixture must actually annotate.
      expect(
        intelligence.services["plex"]?.reasons.map((reason) => reason.code),
        baselineArm,
      ).toContain("image-reference-changed");

      const parsed = rfappsMcpSchemas.plan.output.parse({
        planPath: "/tmp/rfapps-plan.json",
        plan: {
          id: "plan-1",
          createdAt: "2026-07-17T00:00:00.000Z",
          composeHash: "compose-hash",
          composePath: "compose.yml",
          services,
          summary: {
            toCreate: 0,
            toUpdate: 0,
            toRecreate: 1,
            toDelete: 0,
            unchanged: 0,
            updatesAvailable: 0,
            total: 1,
          },
          intelligence,
        },
      });

      expect(parsed, baselineArm).toMatchObject({ plan: { intelligence } });
      expect(parsed, baselineArm).toMatchObject({
        plan: { intelligence: { provenance: { baseline: baselineArm } } },
      });
    }
  });

  it("accepts every valid update-status evidence branch in existing plan results", () => {
    const cases = [
      [
        "update-available",
        {
          changed: false,
          updateStatus: "update-available",
          updateAvailable: true,
          canonicalImage: "docker.io/library/plex:latest",
          platform: "linux/amd64",
          localDigest: "plex@sha256:old",
          remoteDigest: "plex@sha256:new",
        },
      ],
      [
        "up-to-date",
        {
          changed: false,
          updateStatus: "up-to-date",
          updateAvailable: false,
          localDigest: "plex@sha256:same",
          remoteDigest: "plex@sha256:same",
        },
      ],
      [
        "unsupported",
        {
          changed: false,
          updateStatus: "unsupported",
          updateAvailable: false,
          errorCode: "build-only",
        },
      ],
      [
        "local-missing",
        {
          changed: false,
          updateStatus: "local-missing",
          updateAvailable: false,
          remoteDigest: "plex@sha256:remote",
        },
      ],
      [
        "unknown",
        {
          changed: false,
          updateStatus: "unknown",
          updateAvailable: false,
          updateError: "Registry lookup was unavailable.",
          errorCode: "registry-unavailable",
        },
      ],
    ] as const;

    for (const [status, image] of cases) {
      const parsed = rfappsMcpSchemas.plan.output.parse(makePlanOutput(image, "managed-update"));

      expect(parsed, status).toMatchObject({
        plan: {
          intent: "managed-update",
          services: [{ image: { updateStatus: status } }],
        },
      });
    }
  });

  it("rejects every invalid update-status discriminator combination", () => {
    const cases = [
      [
        "update-available marked false",
        {
          changed: false,
          updateStatus: "update-available",
          updateAvailable: false,
          localDigest: "plex@sha256:old",
          remoteDigest: "plex@sha256:new",
        },
      ],
      [
        "up-to-date marked true",
        {
          changed: false,
          updateStatus: "up-to-date",
          updateAvailable: true,
          localDigest: "plex@sha256:same",
          remoteDigest: "plex@sha256:same",
        },
      ],
      [
        "unsupported marked true",
        { changed: false, updateStatus: "unsupported", updateAvailable: true },
      ],
      [
        "local-missing marked true",
        { changed: false, updateStatus: "local-missing", updateAvailable: true },
      ],
      [
        "unknown without diagnostic evidence",
        { changed: false, updateStatus: "unknown", updateAvailable: false },
      ],
    ] as const;

    for (const [name, image] of cases) {
      expect(() => rfappsMcpSchemas.plan.output.parse(makePlanOutput(image)), name).toThrowError(
        McpSchemaValidationError,
      );
    }
  });

  it("accepts managed update history evidence and filters", () => {
    expect(
      rfappsMcpSchemas.history.input.parse({
        service: "plex",
        action: "update",
      }),
    ).toMatchObject({ action: "update" });

    expect(
      rfappsMcpSchemas.history.output.parse({
        entries: [
          {
            id: 2,
            timestamp: "2026-07-17T00:00:00.000Z",
            service: "plex",
            action: "update",
            imageTag: "plex:latest",
            imageId: "sha256:image-id",
            imageDigest: "plex@sha256:repository-digest",
            status: "success",
            planId: "managed-plan-1",
          },
        ],
        totalCount: 1,
        filters: { action: "update", limit: 10 },
      }),
    ).toMatchObject({
      entries: [
        {
          action: "update",
          imageId: "sha256:image-id",
          imageDigest: "plex@sha256:repository-digest",
        },
      ],
      filters: { action: "update" },
    });
  });

  it("does not expose a managed update mutation schema", () => {
    expect(rfappsMcpSchemas).not.toHaveProperty("update");
  });

  it("validates health output shape", () => {
    const parsed = rfappsMcpSchemas.health.output.parse({
      services: ["traefik"],
      ready: true,
      timedOut: false,
      totalDependencies: 1,
      readyDependencies: ["authentik-db"],
      pendingDependencies: [],
      failedDependencies: [],
      attempts: 1,
      elapsedMs: 1200,
      details: [
        {
          service: "traefik",
          dependencies: [
            {
              dependency: "authentik-db",
              status: "ready",
              probes: [
                {
                  type: "container-health",
                  status: "ready",
                },
              ],
            },
          ],
        },
      ],
    });

    expect(parsed).toMatchObject({
      services: ["traefik"],
      ready: true,
      totalDependencies: 1,
    });
  });
});
