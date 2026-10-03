import { beforeEach, describe, expect, it, vi } from "vitest";

import * as configLib from "../config.js";
import * as dbLib from "../db.js";
import * as dockerLib from "../docker.js";
import * as healthLib from "../health.js";
import * as lintLib from "../lint.js";
import * as planLib from "../plan-generator.js";
import * as securityAuditLib from "../security-audit.js";
import * as serviceStatusLib from "../service-status.js";
import * as stateQueriesLib from "../state-queries.js";
import {
  runConfigDoctorCheck,
  runDoctorChecks,
  runStateDoctorCheck,
  runUpdateDoctorCheck,
} from "./checkers.js";
import type { DoctorCheckContext } from "../../types/doctor.js";
import type { DeploymentPlan } from "../../types/plan.js";
import type { RfappsConfig } from "../../types/config.js";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    ...actual,
    getStateDbPath: vi.fn(),
  };
});
vi.mock("../db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db.js")>();
  return {
    ...actual,
    closeDatabase: vi.fn(),
    initializeDatabase: vi.fn(),
  };
});
vi.mock("../docker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../docker.js")>();
  return {
    ...actual,
    getComposeConfig: vi.fn(),
  };
});
vi.mock("../health.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../health.js")>();
  return {
    ...actual,
    waitForDependencyReadiness: vi.fn(),
  };
});
vi.mock("../lint.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lint.js")>();
  return {
    ...actual,
    evaluateLint: vi.fn(),
  };
});
vi.mock("../security-audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../security-audit.js")>();
  return {
    ...actual,
    evaluateSecurityAudit: vi.fn(),
  };
});
vi.mock("../plan-generator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plan-generator.js")>();
  return {
    ...actual,
    generatePlan: vi.fn(),
  };
});
vi.mock("../service-status.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../service-status.js")>();
  return {
    ...actual,
    getServiceStatusMap: vi.fn(),
  };
});
vi.mock("../state-queries.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state-queries.js")>();
  return {
    ...actual,
    getDeploymentCount: vi.fn(),
    getDeploymentHistory: vi.fn(),
  };
});

const config: RfappsConfig = {
  composePath: "compose.yml",
  envFile: ".env",
  profiles: { defaultProfile: "all", validProfiles: ["all"], mapping: {} },
  sidecars: { enabled: true, mapping: {} },
  groups: {},
  healthCheck: { timeout: 30, interval: 5, retries: 3, waitForReady: true },
  envTool: { tool: "none" },
  docker: {},
  interactive: { pageSize: 10 },
  state: { enabled: true, dbPath: "/tmp/missing-rfapps-state.db" },
  parallel: { enabled: false, workers: 4 },
  lint: { ignore: [] },
};

function context(overrides: Partial<DoctorCheckContext> = {}): DoctorCheckContext {
  return {
    config,
    composePath: "compose.yml",
    services: ["plex"],
    profiles: ["all"],
    projectDir: "/repo",
    checkUpdates: false,
    ...overrides,
  };
}

describe("doctor checkers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps lint config findings and shared audit security findings into doctor findings", async () => {
    vi.mocked(dockerLib.getComposeConfig).mockResolvedValue({ services: {} });
    vi.mocked(lintLib.evaluateLint).mockReturnValue({
      timestamp: "now",
      mode: "static",
      summary: { error: 1, warn: 1, info: 0, total: 2 },
      findings: [
        {
          ruleId: "privileged-enabled",
          service: "plex",
          severity: "error",
          message: "Privileged mode enabled",
          remediation: "remove privileged",
          group: "recommended",
        },
        {
          ruleId: "healthcheck-missing",
          service: "plex",
          severity: "warn",
          message: "Health check missing",
          remediation: "add healthcheck",
          group: "recommended",
        },
      ],
    });
    vi.mocked(securityAuditLib.evaluateSecurityAudit).mockReturnValue({
      timestamp: "now",
      summary: { critical: 1, error: 0, warn: 0, info: 0, total: 1 },
      findings: [
        {
          ruleId: "privileged-container",
          category: "privileges",
          service: "plex",
          severity: "critical",
          message: "Privileged mode enabled",
          evidence: ["privileged=true"],
          remediation: "remove privileged",
        },
      ],
    });

    const result = await runConfigDoctorCheck(context());

    expect(securityAuditLib.evaluateSecurityAudit).toHaveBeenCalledWith({ services: {} }, ["plex"]);
    expect(result.checks).toEqual([
      { id: "config-lint", category: "config", status: "run" },
      { id: "security-audit", category: "security", status: "run" },
    ]);
    expect(result.findings).toEqual([
      expect.objectContaining({
        id: "config.healthcheck-missing",
        severity: "warn",
        category: "config",
        suggestedCommand: "rfapps lint -s plex",
      }),
      expect.objectContaining({
        id: "security.privileged-container",
        severity: "critical",
        category: "security",
        suggestedCommand: "rfapps audit -s plex",
      }),
    ]);
  });

  it("skips update checks by default and maps opt-in image updates", async () => {
    await expect(runUpdateDoctorCheck(context())).resolves.toEqual({
      checks: [
        {
          id: "image-updates",
          category: "updates",
          status: "skipped",
          message: "registry update checks require --check-updates",
        },
      ],
      findings: [],
    });

    const plan: DeploymentPlan = {
      id: "plan",
      createdAt: "now",
      composeHash: "",
      composePath: "compose.yml",
      services: [
        {
          service: "plex",
          changeType: "unchanged",
          image: {
            changed: false,
            current: "plex:old",
            desired: "plex:old",
            updateAvailable: true,
          },
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
        updatesAvailable: 1,
        total: 1,
      },
    };
    vi.mocked(planLib.generatePlan).mockResolvedValue(plan);

    const result = await runUpdateDoctorCheck(context({ checkUpdates: true }));

    expect(planLib.generatePlan).toHaveBeenCalledWith(
      { composePath: "compose.yml", services: ["plex"], profiles: ["all"], checkUpdates: true },
      undefined,
    );
    expect(result.findings).toEqual([
      expect.objectContaining({
        id: "updates.image-available",
        severity: "warn",
        service: "plex",
      }),
    ]);
  });

  it("skips state when disabled or missing", async () => {
    await expect(
      runStateDoctorCheck(context({ config: { ...config, state: { enabled: false } } })),
    ).resolves.toEqual({
      checks: [
        {
          id: "state-history",
          category: "state",
          status: "skipped",
          message: "state persistence is disabled",
        },
      ],
      findings: [],
    });

    vi.mocked(configLib.getStateDbPath).mockReturnValue("/tmp/missing-rfapps-state.db");
    const result = await runStateDoctorCheck(context());

    expect(result.checks[0]).toEqual({
      id: "state-history",
      category: "state",
      status: "skipped",
      message: "state database not found",
    });
    expect(dbLib.initializeDatabase).not.toHaveBeenCalled();
  });

  it("isolates checker failures in the aggregate runner", async () => {
    vi.mocked(dockerLib.getComposeConfig).mockRejectedValue(new Error("compose failed"));
    vi.mocked(lintLib.evaluateLint).mockReturnValue({
      timestamp: "now",
      mode: "static",
      summary: { error: 0, warn: 0, info: 0, total: 0 },
      findings: [],
    });
    vi.mocked(securityAuditLib.evaluateSecurityAudit).mockReturnValue({
      timestamp: "now",
      summary: { critical: 0, error: 0, warn: 0, info: 0, total: 0 },
      findings: [],
    });
    vi.mocked(serviceStatusLib.getServiceStatusMap).mockResolvedValue(new Map());
    vi.mocked(healthLib.waitForDependencyReadiness).mockResolvedValue({
      ready: true,
      timedOut: false,
      totalDependencies: 0,
      readyDependencies: [],
      pendingDependencies: [],
      failedDependencies: [],
      elapsedMs: 0,
      attempts: 1,
      services: [],
      signalAvailability: { available: true, unavailableSignals: [] },
    });
    vi.mocked(configLib.getStateDbPath).mockReturnValue("/tmp/missing-rfapps-state.db");

    const result = await runDoctorChecks(context());

    expect(result.checks.some((check) => check.status === "failed")).toBe(true);
    expect(result.checks.some((check) => check.id === "image-updates")).toBe(true);
  });
});
