import { beforeEach, describe, expect, it, vi } from "vitest";

const adapterMocks = vi.hoisted(() => ({
  apply: vi.fn(),
  delete: vi.fn(),
  deploy: vi.fn(),
  driftDetect: vi.fn(),
  driftImport: vi.fn(),
  driftReconcile: vi.fn(),
  driftShow: vi.fn(),
  health: vi.fn(),
  history: vi.fn(),
  plan: vi.fn(),
  prune: vi.fn(),
  pull: vi.fn(),
  rebuild: vi.fn(),
  rollback: vi.fn(),
  status: vi.fn(),
  stop: vi.fn(),
}));

const stateLockMocks = vi.hoisted(() => ({
  withStateLock: vi.fn(async (_operation: string, callback: () => Promise<unknown>) => callback()),
}));

vi.mock("./adapters.js", () => ({
  rfappsActionAdapters: adapterMocks,
}));
vi.mock("../lib/state-lock.js", () => stateLockMocks);

import { rfappsMutationTools } from "./tools-mutate.js";
import { rfappsReadTools } from "./tools-read.js";
import { RFAPPS_MCP_TOOL_NAMES, rfappsMcpSchemas } from "./schema.js";
import { rfappsMcpTools } from "./tools.js";

function makeReconcileResult() {
  return {
    schemaVersion: "reconcile.v1" as const,
    operation: "reconcile" as const,
    mode: "auto-apply" as const,
    dryRun: false,
    status: "converged" as const,
    scope: {
      composePath: "/srv/apps/compose.yml",
      project: "rfmedia-apps",
      profiles: ["media"],
      services: ["plex"],
    },
    actionFingerprint: "sha256:reviewed-actions",
    automation: { status: "allowed" as const },
    services: [
      {
        service: "plex",
        comparison: "drifted" as const,
        drift: {
          hasDrift: true,
          direction: "compose_ahead" as const,
          categories: ["runtime-status" as const],
          image: { changed: false },
          environment: [],
          ports: { changed: false },
          volumes: { changed: false },
          networks: { changed: false },
          runtimeStatus: {
            changed: true,
            currentState: "exited" as const,
            currentHealth: "none" as const,
            desiredState: "running" as const,
            desiredHealth: "healthy" as const,
          },
        },
        action: {
          kind: "start" as const,
          categories: ["runtime-status" as const],
          eligibility: "allowed" as const,
          reasons: [{ code: "RECONCILE_CONTAINER_STOPPED", category: "runtime-status" as const }],
        },
        outcome: "converged" as const,
        finalDrift: {
          hasDrift: false,
          direction: "compose_ahead" as const,
          categories: [],
          image: { changed: false },
          environment: [],
          ports: { changed: false },
          volumes: { changed: false },
          networks: { changed: false },
          runtimeStatus: {
            changed: false,
            currentState: "running" as const,
            currentHealth: "healthy" as const,
            desiredState: "running" as const,
            desiredHealth: "healthy" as const,
          },
        },
      },
    ],
    summary: {
      selected: 1,
      inSync: 0,
      drifted: 1,
      actionable: 1,
      blocked: 0,
      converged: 1,
      failed: 0,
    },
    success: true,
    exitCode: 0 as const,
  };
}

describe("MCP tool definitions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers read tool definitions with schemas and delegates to action adapters", async () => {
    expect(rfappsReadTools.map((tool) => tool.name)).toEqual([
      RFAPPS_MCP_TOOL_NAMES.status,
      RFAPPS_MCP_TOOL_NAMES.health,
      RFAPPS_MCP_TOOL_NAMES.plan,
      RFAPPS_MCP_TOOL_NAMES.history,
      RFAPPS_MCP_TOOL_NAMES.driftDetect,
      RFAPPS_MCP_TOOL_NAMES.driftShow,
    ]);

    const cases = [
      [RFAPPS_MCP_TOOL_NAMES.status, adapterMocks.status, { service: "plex" }],
      [RFAPPS_MCP_TOOL_NAMES.health, adapterMocks.health, { service: "traefik" }],
      [RFAPPS_MCP_TOOL_NAMES.plan, adapterMocks.plan, { group: "media-stack", checkUpdates: true }],
      [RFAPPS_MCP_TOOL_NAMES.history, adapterMocks.history, { limit: 5 }],
      [RFAPPS_MCP_TOOL_NAMES.driftDetect, adapterMocks.driftDetect, { services: "plex,sonarr" }],
      [RFAPPS_MCP_TOOL_NAMES.driftShow, adapterMocks.driftShow, { service: "plex" }],
    ] as const;

    for (const [name, adapter, args] of cases) {
      const result = { name, ok: true };
      const tool = rfappsReadTools.find((definition) => definition.name === name);

      adapter.mockResolvedValueOnce(result);

      await expect(tool!.handler(args, undefined as never)).resolves.toEqual(result);
      expect(adapter).toHaveBeenCalledWith(args);
      expect(tool!.inputSchema).toBeDefined();
      expect(tool!.outputSchema).toBeDefined();
    }
  });

  it("keeps dry-run and report-only mutation definitions lock-free", async () => {
    adapterMocks.pull.mockResolvedValueOnce({ dryRun: true });
    adapterMocks.driftReconcile.mockResolvedValueOnce(makeReconcileResult());

    const pull = rfappsMutationTools.find(
      (definition) => definition.name === RFAPPS_MCP_TOOL_NAMES.pull,
    );
    const reconcile = rfappsMutationTools.find(
      (definition) => definition.name === RFAPPS_MCP_TOOL_NAMES.driftReconcile,
    );

    await pull!.handler({ service: "plex", dryRun: true }, undefined as never);
    await reconcile!.handler({ service: "plex", autoApply: false }, undefined as never);

    expect(stateLockMocks.withStateLock).not.toHaveBeenCalled();
  });

  it("locks MCP plan apply but keeps preview and dry-run apply lock-free", async () => {
    const plan = rfappsReadTools.find(
      (definition) => definition.name === RFAPPS_MCP_TOOL_NAMES.plan,
    );
    adapterMocks.plan.mockResolvedValue({ planPath: "/tmp/plan.json" });

    await plan!.handler({ service: "plex" }, undefined as never);
    await plan!.handler({ service: "plex", apply: true, dryRun: true }, undefined as never);
    expect(stateLockMocks.withStateLock).not.toHaveBeenCalled();

    await plan!.handler({ service: "plex", apply: true }, undefined as never);
    expect(stateLockMocks.withStateLock).toHaveBeenCalledOnce();
    expect(stateLockMocks.withStateLock).toHaveBeenCalledWith("plan", expect.any(Function));
  });

  it("registers mutation tool definitions with schemas and delegates to action adapters", async () => {
    expect(rfappsMutationTools.map((tool) => tool.name)).toEqual([
      RFAPPS_MCP_TOOL_NAMES.pull,
      RFAPPS_MCP_TOOL_NAMES.deploy,
      RFAPPS_MCP_TOOL_NAMES.rebuild,
      RFAPPS_MCP_TOOL_NAMES.stop,
      RFAPPS_MCP_TOOL_NAMES.delete,
      RFAPPS_MCP_TOOL_NAMES.prune,
      RFAPPS_MCP_TOOL_NAMES.apply,
      RFAPPS_MCP_TOOL_NAMES.rollback,
      RFAPPS_MCP_TOOL_NAMES.driftReconcile,
      RFAPPS_MCP_TOOL_NAMES.driftImport,
    ]);

    const cases = [
      [RFAPPS_MCP_TOOL_NAMES.pull, adapterMocks.pull, { service: "plex", yes: true }],
      [RFAPPS_MCP_TOOL_NAMES.deploy, adapterMocks.deploy, { group: "media-stack", yes: true }],
      [RFAPPS_MCP_TOOL_NAMES.rebuild, adapterMocks.rebuild, { services: "plex,sonarr", yes: true }],
      [RFAPPS_MCP_TOOL_NAMES.stop, adapterMocks.stop, { service: "plex", yes: true }],
      [
        RFAPPS_MCP_TOOL_NAMES.delete,
        adapterMocks.delete,
        { service: "plex", volumes: true, yes: true },
      ],
      [
        RFAPPS_MCP_TOOL_NAMES.prune,
        adapterMocks.prune,
        { service: "plex", images: true, yes: true },
      ],
      [
        RFAPPS_MCP_TOOL_NAMES.apply,
        adapterMocks.apply,
        { planFile: ".rfapps/plan.json", yes: true },
      ],
      [
        RFAPPS_MCP_TOOL_NAMES.rollback,
        adapterMocks.rollback,
        { service: "plex", deploymentId: "dep-1" },
      ],
      [
        RFAPPS_MCP_TOOL_NAMES.driftReconcile,
        adapterMocks.driftReconcile,
        { service: "plex", autoApply: true, yes: true },
      ],
      [RFAPPS_MCP_TOOL_NAMES.driftImport, adapterMocks.driftImport, { service: "plex", yes: true }],
    ] as const;

    for (const [name, adapter, args] of cases) {
      const result = { name, success: true };
      const tool = rfappsMutationTools.find((definition) => definition.name === name);

      adapter.mockResolvedValueOnce(result);

      await expect(tool!.handler(args, undefined as never)).resolves.toEqual(result);
      expect(adapter).toHaveBeenCalledWith(args);
      expect(tool!.inputSchema).toBeDefined();
      expect(tool!.outputSchema).toBeDefined();
    }

    expect(stateLockMocks.withStateLock).toHaveBeenCalledTimes(cases.length);
  });

  it("publishes exactly one reconciliation tool and classifies it as a mutation", () => {
    const publicReconcileTools = rfappsMcpTools.filter((tool) =>
      tool.name.toLowerCase().includes("reconcile"),
    );
    const mutationReconcileTools = rfappsMutationTools.filter((tool) =>
      tool.name.toLowerCase().includes("reconcile"),
    );

    expect(publicReconcileTools).toHaveLength(1);
    expect(mutationReconcileTools).toHaveLength(1);
    expect(publicReconcileTools[0]).toBe(mutationReconcileTools[0]);
    expect(publicReconcileTools[0]?.name).toBe("rfapps.drift.reconcile");
    expect(rfappsReadTools).not.toContain(publicReconcileTools[0]);
    expect(rfappsMcpTools.some((tool) => tool.name === "rfapps.reconcile")).toBe(false);
  });

  it("binds the retained reconciliation tool to the exact input and result schemas", () => {
    const tool = rfappsMutationTools.find(
      (definition) => definition.name === RFAPPS_MCP_TOOL_NAMES.driftReconcile,
    );

    expect(tool).toBeDefined();
    expect(tool!.inputSchema).toBe(rfappsMcpSchemas.driftReconcile.input);
    expect(tool!.outputSchema).toBe(rfappsMcpSchemas.driftReconcile.output);
    expect(tool!.inputSchema.jsonSchema).toEqual(rfappsMcpSchemas.driftReconcile.input.jsonSchema);
    expect(tool!.outputSchema.jsonSchema).toEqual(
      rfappsMcpSchemas.driftReconcile.output.jsonSchema,
    );
  });

  it("requires explicit yes for reconciliation auto-apply before adapter delegation", async () => {
    const tool = rfappsMutationTools.find(
      (definition) => definition.name === RFAPPS_MCP_TOOL_NAMES.driftReconcile,
    );

    await expect(tool!.handler({ autoApply: true }, undefined as never)).rejects.toThrowError();
    await expect(
      tool!.handler({ autoApply: true, yes: false }, undefined as never),
    ).rejects.toThrowError();
    expect(adapterMocks.driftReconcile).not.toHaveBeenCalled();
  });

  it("returns the complete reconciliation result without a fallback projection", async () => {
    const expected = makeReconcileResult();
    const tool = rfappsMutationTools.find(
      (definition) => definition.name === RFAPPS_MCP_TOOL_NAMES.driftReconcile,
    );
    adapterMocks.driftReconcile.mockResolvedValueOnce(expected);

    const result = await tool!.handler(
      { service: "plex", autoApply: true, yes: true },
      undefined as never,
    );

    expect(result).toBe(expected);
    expect(result).toEqual(expected);
    expect(result).not.toEqual({ success: true, operation: "reconcile", services: ["plex"] });
    expect(adapterMocks.driftReconcile).toHaveBeenCalledWith({
      service: "plex",
      autoApply: true,
      yes: true,
    });
  });
});
