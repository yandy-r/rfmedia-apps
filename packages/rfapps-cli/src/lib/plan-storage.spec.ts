import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DeploymentPlan } from "../types/plan.js";
import type { ManagedUpdatePlan, ManagedUpdateResult } from "../types/update.js";
import {
  deletePlan,
  hashFile,
  listPlans,
  loadManagedUpdatePlan,
  loadManagedUpdateResult,
  loadPlan,
  ManagedArtifactStorageError,
  MAX_MANAGED_ARTIFACT_BYTES,
  reserveManagedUpdateResultPath,
  saveManagedUpdatePlan,
  saveManagedUpdateResult,
  savePlan,
  validatePlan,
} from "./plan-storage.js";

describe("plan storage", () => {
  let tempDir: string;
  let composePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rfapps-plan-storage-"));
    composePath = join(tempDir, "compose.yml");
    await writeFile(composePath, "services:\n  app:\n    image: app:latest\n", "utf-8");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function makePlan(overrides: Partial<DeploymentPlan> = {}): DeploymentPlan {
    return {
      id: "plan-1",
      createdAt: new Date().toISOString(),
      composeHash: "",
      composePath,
      services: [],
      summary: {
        toCreate: 0,
        toUpdate: 0,
        toRecreate: 0,
        toDelete: 0,
        unchanged: 0,
        updatesAvailable: 0,
        total: 0,
      },
      ...overrides,
    };
  }

  function makeManagedPlan(overrides: Partial<ManagedUpdatePlan> = {}): ManagedUpdatePlan {
    return {
      schemaVersion: "update-plan.v1",
      intent: "managed-update",
      id: "managed-plan-1",
      createdAt: "2026-07-17T00:00:00.000Z",
      composeHash: "a".repeat(64),
      composePath,
      profiles: ["all"],
      dockerContextFingerprint: "context-fingerprint",
      envSourceFingerprint: "a".repeat(64),
      composeProjectName: "project",
      targetServices: ["app"],
      applyPolicy: "sequential",
      restorePolicy: "restore-on-failure",
      services: [
        {
          service: "app",
          resolvedConfigFingerprint: "b".repeat(64),
          status: "update-available",
          configuredImage: "registry.example/app:latest",
          platform: "linux-amd64",
          currentImageId: `sha256:${"1".repeat(64)}`,
          currentDigest: `sha256:${"2".repeat(64)}`,
          proposedDigest: `sha256:${"3".repeat(64)}`,
          recoveryGeneration: 7,
          recoveryEligible: true,
          verification: "healthcheck",
        },
      ],
      ...overrides,
    };
  }

  function makeManagedResult(overrides: Partial<ManagedUpdateResult> = {}): ManagedUpdateResult {
    const lifecycleError = {
      kind: "lifecycle" as const,
      stage: "verify_update" as const,
      code: "HEALTH_FAILED",
      message: "target failed password=report-secret",
    };
    return {
      schemaVersion: "update.v1",
      runId: "run-1",
      planId: "managed-plan-1",
      startedAt: "2026-07-17T00:00:00.000Z",
      completedAt: "2026-07-17T00:01:00.000Z",
      status: "failed",
      success: false,
      exitCode: 1,
      applied: true,
      restoreOnFailure: true,
      summary: {
        selected: 1,
        actionable: 1,
        updated: 0,
        restored: 0,
        upToDate: 0,
        unsupported: 0,
        unknown: 0,
        blocked: 0,
        failed: 1,
        interrupted: 0,
      },
      services: [
        {
          service: "app",
          outcome: "update_failed",
          stage: "verify_update",
          reviewedIdentity: {
            configuredImage: "registry.example/app:latest",
            currentImageId: `sha256:${"1".repeat(64)}`,
            proposedDigest: `sha256:${"3".repeat(64)}`,
          },
          observedIdentity: {
            configuredImage: "registry.example/app:latest",
            imageId: `sha256:${"4".repeat(64)}`,
          },
          verification: {
            status: "failed",
            assurance: "healthcheck",
            expectedImageId: `sha256:${"4".repeat(64)}`,
            observedImageId: `sha256:${"4".repeat(64)}`,
            runtimeState: "running",
            dockerHealth: "unhealthy",
            dependenciesReady: true,
            elapsedMs: 1_000,
            error: lifecycleError,
          },
          restore: {
            status: "unavailable",
            reasonCode: "RECOVERY_MISSING",
            message: "restore unavailable token=restore-secret",
          },
          generations: { before: 7 },
          durationMs: 60_000,
          error: lifecycleError,
        },
      ],
      ...overrides,
    };
  }

  it("hashes readable files and returns an empty hash for missing files", async () => {
    const hash = await hashFile(composePath);

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(await hashFile(join(tempDir, "missing.yml"))).toBe("");
  });

  it("saves plans with the current compose hash and loads them back", async () => {
    const planPath = join(tempDir, "plans", "custom-plan.json");
    const savedPath = await savePlan(makePlan(), planPath);
    const loaded = await loadPlan(savedPath);

    expect(savedPath).toBe(planPath);
    expect(loaded).toMatchObject({
      id: "plan-1",
      composePath,
    });
    expect(loaded?.composeHash).toBe(await hashFile(composePath));
  });

  it("returns undefined when loading invalid or missing plan files", async () => {
    const invalidPath = join(tempDir, "invalid.json");
    await writeFile(invalidPath, "{not-json", "utf-8");

    expect(await loadPlan(invalidPath)).toBeUndefined();
    expect(await loadPlan(join(tempDir, "missing.json"))).toBeUndefined();
  });

  it("validates required fields, compose hash drift, force mode, empty services, and stale plans", async () => {
    const composeHash = await hashFile(composePath);
    const freshPlan = makePlan({ composeHash });

    expect(await validatePlan(freshPlan)).toEqual({
      valid: true,
      errors: [],
      warnings: ["Plan contains no services"],
    });

    const missingFields = await validatePlan(makePlan({ id: "", composePath: "" }));
    expect(missingFields.valid).toBe(false);
    expect(missingFields.errors).toContain("Plan ID is missing");
    expect(missingFields.errors).toContain("Compose path is missing");

    await writeFile(composePath, "services:\n  app:\n    image: app:v2\n", "utf-8");
    const drifted = await validatePlan(freshPlan);
    expect(drifted.valid).toBe(false);
    expect(drifted.errors).toContain(
      "Compose file has changed since plan was created. Use --force to apply anyway.",
    );

    const forced = await validatePlan(freshPlan, { force: true });
    expect(forced.valid).toBe(true);
    expect(forced.warnings).toContain(
      "Compose file has changed since plan was created (applying anyway due to --force)",
    );

    const oldPlan = makePlan({
      composeHash: await hashFile(composePath),
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    expect(
      (await validatePlan(oldPlan)).warnings.some((warning) => warning.includes("hours old")),
    ).toBe(true);
  });

  it("lists only plan json files newest first and deletes plans", async () => {
    const planDir = join(tempDir, "plans");
    const olderPath = await savePlan(makePlan({ id: "older" }), join(planDir, "plan-older.json"));
    const newerPath = await savePlan(makePlan({ id: "newer" }), join(planDir, "plan-newer.json"));
    await writeFile(join(planDir, "notes.txt"), "ignore me", "utf-8");

    await stat(olderPath);
    const olderTime = new Date(Date.now() - 10_000);
    const newerTime = new Date();
    await utimes(olderPath, olderTime, olderTime);
    await utimes(newerPath, newerTime, newerTime);
    const plans = await listPlans(planDir);

    expect(plans).toEqual([newerPath, olderPath]);
    expect(await deletePlan(olderPath)).toBe(true);
    expect(await deletePlan(olderPath)).toBe(false);
    expect(await listPlans(join(tempDir, "missing"))).toEqual([]);
  });

  it("writes default timestamped plan files when no custom path is provided", async () => {
    const cwd = process.cwd();
    process.chdir(tempDir);
    try {
      const savedPath = await savePlan(makePlan());
      const content = JSON.parse(await readFile(savedPath, "utf-8")) as DeploymentPlan;

      expect(savedPath).toMatch(/\.rfapps\/plans\/plan-/);
      expect(content.id).toBe("plan-1");
    } finally {
      process.chdir(cwd);
    }
  });

  describe("managed artifacts", () => {
    it("round-trips allowlisted managed plans without secret-bearing extra fields", async () => {
      const secret = "plan-canary-secret";
      const plan = {
        ...makeManagedPlan({
          services: [
            {
              ...makeManagedPlan().services[0]!,
              message: `registry lookup token=${secret}`,
            },
          ],
        }),
        environment: [{ name: "PASSWORD", desired: secret }],
        dockerConnection: `https://user:${secret}@docker.example`,
      };
      const artifactPath = join(tempDir, "managed-plans", "update-plan.json");

      await saveManagedUpdatePlan(plan, artifactPath);
      const content = await readFile(artifactPath, "utf-8");
      const loaded = await loadManagedUpdatePlan(artifactPath);

      expect(content).not.toContain(secret);
      expect(content).not.toContain("environment");
      expect(content).not.toContain("dockerConnection");
      expect(content).toContain("token=[REDACTED]");
      expect(loaded).toEqual(JSON.parse(content));
      expect(loaded.targetServices).toEqual(["app"]);
      expect(loaded.envSourceFingerprint).toBe("a".repeat(64));
      expect(loaded.services[0]?.resolvedConfigFingerprint).toBe("b".repeat(64));
    });

    it("tightens the ordinary default plan directory before saving a managed plan", async () => {
      const cwd = process.cwd();
      process.chdir(tempDir);
      try {
        await savePlan(makePlan());
        await chmod(join(tempDir, ".rfapps", "plans"), 0o755);

        const managedPath = await saveManagedUpdatePlan(makeManagedPlan());

        expect((await stat(join(tempDir, ".rfapps", "plans"))).mode & 0o777).toBe(0o700);
        await expect(loadManagedUpdatePlan(managedPath)).resolves.toMatchObject({
          schemaVersion: "update-plan.v1",
        });
      } finally {
        process.chdir(cwd);
      }
    });

    it("round-trips allowlisted update reports and redacts bounded error text", async () => {
      const report = {
        ...makeManagedResult({
          cleanupFailures: [
            {
              operation: "lock-release",
              code: "CLEANUP_FAILED",
              message: "Bearer cleanup-report-secret",
            },
          ],
        }),
        stderr: "raw subprocess output report-secret",
        resolvedEnvironment: { PASSWORD: "report-secret" },
      };
      const artifactPath = join(tempDir, "managed-reports", "update-result.json");

      await saveManagedUpdateResult(report, artifactPath);
      const content = await readFile(artifactPath, "utf-8");
      const loaded = await loadManagedUpdateResult(artifactPath);

      expect(content).not.toContain("report-secret");
      expect(content).not.toContain("restore-secret");
      expect(content).not.toContain("cleanup-report-secret");
      expect(content).not.toContain("stderr");
      expect(content).not.toContain("resolvedEnvironment");
      expect(content).toContain("password=[REDACTED]");
      expect(content).toContain("token=[REDACTED]");
      expect(loaded.schemaVersion).toBe("update.v1");
      expect(loaded.cleanupFailures).toEqual([
        expect.objectContaining({ operation: "lock-release", code: "CLEANUP_FAILED" }),
      ]);
    });

    it.each([
      ["malformed JSON", "{not-json"],
      [
        "wrong plan schema",
        JSON.stringify({ ...makeManagedPlan(), schemaVersion: "update-plan.v2" }),
      ],
      ["wrong plan intent", JSON.stringify({ ...makeManagedPlan(), intent: "deployment" })],
      ["unknown plan field", JSON.stringify({ ...makeManagedPlan(), credential: "secret" })],
    ])("rejects %s when loading managed plans", async (_name, content) => {
      const artifactPath = join(tempDir, "invalid-managed-plan.json");
      await writeFile(artifactPath, content, { mode: 0o600 });

      await expect(loadManagedUpdatePlan(artifactPath)).rejects.toMatchObject({
        code: "MANAGED_ARTIFACT_INVALID",
      });
    });

    it("rejects wrong result schemas and unknown report fields", async () => {
      const artifactPath = join(tempDir, "invalid-result.json");
      await writeFile(
        artifactPath,
        JSON.stringify({ ...makeManagedResult(), schemaVersion: "update.v2" }),
        { mode: 0o600 },
      );
      await expect(loadManagedUpdateResult(artifactPath)).rejects.toMatchObject({
        code: "MANAGED_ARTIFACT_INVALID",
      });

      await writeFile(
        artifactPath,
        JSON.stringify({ ...makeManagedResult(), rawOutput: "not allowed" }),
        { mode: 0o600 },
      );
      await expect(loadManagedUpdateResult(artifactPath)).rejects.toMatchObject({
        code: "MANAGED_ARTIFACT_INVALID",
      });
    });

    it("accepts an interrupted result before any mutation was applied", async () => {
      const base = makeManagedResult();
      const result = makeManagedResult({
        status: "interrupted",
        success: false,
        exitCode: 1,
        applied: false,
        summary: {
          selected: 1,
          actionable: 1,
          updated: 0,
          restored: 0,
          upToDate: 0,
          unsupported: 0,
          unknown: 0,
          blocked: 0,
          failed: 0,
          interrupted: 1,
        },
        services: [
          {
            ...base.services[0]!,
            outcome: "interrupted",
            stage: "interrupted",
            error: {
              kind: "lifecycle",
              stage: "interrupted",
              code: "INTERRUPTED",
              message: "Interrupted before apply",
            },
          },
        ],
        interruption: { signal: "SIGTERM", stage: "validate", stabilized: true },
      });
      const artifactPath = join(tempDir, "early-interruption.json");
      await writeFile(artifactPath, JSON.stringify(result), { mode: 0o600 });

      await expect(loadManagedUpdateResult(artifactPath)).resolves.toMatchObject({
        status: "interrupted",
        applied: false,
      });
    });

    it.each([
      [
        "summary counters that disagree with service outcomes",
        () => {
          const result = makeManagedResult();
          return { ...result, summary: { ...result.summary, failed: 0 } };
        },
      ],
      [
        "aggregate status fields that disagree with service outcomes",
        () => ({ ...makeManagedResult(), status: "succeeded", success: true, exitCode: 0 }),
      ],
      [
        "a non-applied result with mutation outcomes",
        () => ({ ...makeManagedResult(), applied: false }),
      ],
      [
        "an actionable count that excludes a definitive actionable outcome",
        () => {
          const result = makeManagedResult();
          return { ...result, summary: { ...result.summary, actionable: 0 } };
        },
      ],
    ])("rejects %s", async (_name, makeInvalidResult) => {
      const artifactPath = join(tempDir, "invalid-result-semantics.json");
      await writeFile(artifactPath, JSON.stringify(makeInvalidResult()), { mode: 0o600 });

      await expect(loadManagedUpdateResult(artifactPath)).rejects.toMatchObject({
        code: "MANAGED_ARTIFACT_INVALID",
      });
    });

    it("rejects oversized managed artifacts before parsing", async () => {
      const artifactPath = join(tempDir, "oversized.json");
      await writeFile(artifactPath, "x".repeat(MAX_MANAGED_ARTIFACT_BYTES + 1), {
        mode: 0o600,
      });

      await expect(loadManagedUpdatePlan(artifactPath)).rejects.toMatchObject({
        code: "MANAGED_ARTIFACT_TOO_LARGE",
      });
    });

    it("rejects traversal paths and symlinked parents or files", async () => {
      await expect(
        saveManagedUpdatePlan(makeManagedPlan(), `${tempDir}/managed/../escaped-plan.json`),
      ).rejects.toMatchObject({ code: "MANAGED_ARTIFACT_PATH_UNSAFE" });

      const realDir = join(tempDir, "real-dir");
      const linkedDir = join(tempDir, "linked-dir");
      await mkdir(realDir, { mode: 0o700 });
      await symlink(realDir, linkedDir);
      await expect(
        saveManagedUpdatePlan(makeManagedPlan(), join(linkedDir, "plan.json")),
      ).rejects.toMatchObject({ code: "MANAGED_ARTIFACT_PATH_UNSAFE" });

      const targetPath = join(realDir, "target.json");
      const linkedFile = join(tempDir, "linked-plan.json");
      await writeFile(targetPath, JSON.stringify(makeManagedPlan()), { mode: 0o600 });
      await symlink(targetPath, linkedFile);
      await expect(loadManagedUpdatePlan(linkedFile)).rejects.toMatchObject({
        code: "MANAGED_ARTIFACT_PATH_UNSAFE",
      });
    });

    it("requires explicit overwrite and atomically replaces without leftover temporary files", async () => {
      const artifactDir = join(tempDir, "replacement");
      const artifactPath = join(artifactDir, "managed.json");
      await saveManagedUpdatePlan(makeManagedPlan(), artifactPath);

      await expect(
        saveManagedUpdateResult(makeManagedResult(), artifactPath),
      ).rejects.toBeInstanceOf(ManagedArtifactStorageError);
      await expect(
        saveManagedUpdateResult(makeManagedResult(), artifactPath),
      ).rejects.toMatchObject({
        code: "MANAGED_ARTIFACT_EXISTS",
      });

      await saveManagedUpdateResult(makeManagedResult(), artifactPath, { overwrite: true });

      expect((await loadManagedUpdateResult(artifactPath)).schemaVersion).toBe("update.v1");
      expect((await readdir(artifactDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });

    it("reserves a private report path without publishing a terminal result", async () => {
      const artifactPath = join(tempDir, "reserved", "update-result.json");

      await reserveManagedUpdateResultPath(artifactPath);

      expect((await stat(artifactPath)).size).toBe(0);
      expect((await stat(artifactPath)).mode & 0o777).toBe(0o600);
      await expect(loadManagedUpdateResult(artifactPath)).rejects.toMatchObject({
        code: "MANAGED_ARTIFACT_INVALID",
      });
      await expect(reserveManagedUpdateResultPath(artifactPath)).rejects.toMatchObject({
        code: "MANAGED_ARTIFACT_EXISTS",
      });

      await saveManagedUpdateResult(makeManagedResult(), artifactPath, { overwrite: true });
      await expect(loadManagedUpdateResult(artifactPath)).resolves.toMatchObject({
        schemaVersion: "update.v1",
      });
    });

    it("creates private artifact directories and files", async () => {
      const artifactDir = join(tempDir, "private", "reports");
      const artifactPath = join(artifactDir, "result.json");

      await saveManagedUpdateResult(makeManagedResult(), artifactPath);

      expect((await stat(artifactDir)).mode & 0o777).toBe(0o700);
      expect((await stat(artifactPath)).mode & 0o777).toBe(0o600);
      expect((await lstat(artifactPath)).isSymbolicLink()).toBe(false);
    });

    it("tightens an existing current-user-owned output directory", async () => {
      const publicDir = join(tempDir, "public");
      await mkdir(publicDir, { mode: 0o755 });
      await chmod(publicDir, 0o755);

      await saveManagedUpdatePlan(makeManagedPlan(), join(publicDir, "plan.json"));

      expect((await stat(publicDir)).mode & 0o777).toBe(0o700);
    });
  });
});
