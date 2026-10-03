import { beforeEach, describe, expect, it, vi } from "vitest";

import { BackupSchemaError } from "../lib/backup-schema.js";
import type { BackupVerifyResult } from "../types/backup.js";
import { executeBackupVerify, type BackupVerifyActionDependencies } from "./backup-verify.js";

function verifiedResult(): BackupVerifyResult {
  return {
    schemaVersion: "rfapps-backup-verify-result.v1",
    operation: "backup-verify",
    status: "succeeded",
    success: true,
    exitCode: 0,
    dryRun: false,
    manifestPath: "/bundle/manifest.json",
    bundlePath: "/bundle",
    artifacts: [],
    warnings: [],
    errors: [],
    summary: {
      declaredArtifacts: 0,
      verifiedArtifacts: 0,
      unexpectedArtifacts: 0,
      missingArtifacts: 0,
      unsafeArtifacts: 0,
      sizeMismatches: 0,
      checksumMismatches: 0,
    },
  };
}

function dependencies(
  overrides: Partial<BackupVerifyActionDependencies> = {},
): BackupVerifyActionDependencies {
  return {
    verifyBackup: vi.fn(async () => verifiedResult()),
    formatOutput: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("executeBackupVerify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it("emits exactly one versioned machine document from the offline verifier", async () => {
    const deps = dependencies();

    await executeBackupVerify("/bundle/manifest.json", { output: "json" }, deps);

    expect(deps.verifyBackup).toHaveBeenCalledOnce();
    expect(deps.formatOutput).toHaveBeenCalledOnce();
    expect(deps.formatOutput).toHaveBeenCalledWith("json", verifiedResult());
    expect(process.exitCode).toBeUndefined();
  });

  it("preserves integrity failure exit 1", async () => {
    const error = {
      kind: "operational" as const,
      stage: "verify" as const,
      code: "BACKUP_ARTIFACT_MISSING",
      message: "Declared backup artifact is missing",
    };
    const failure: BackupVerifyResult = {
      ...verifiedResult(),
      status: "failed",
      success: false,
      exitCode: 1,
      artifacts: [],
      errors: [error],
    };
    const deps = dependencies({ verifyBackup: vi.fn(async () => failure) });

    await executeBackupVerify("/bundle/manifest.json", { output: "yaml" }, deps);

    expect(deps.formatOutput).toHaveBeenCalledWith("yaml", failure);
    expect(process.exitCode).toBe(1);
  });

  it("turns malformed manifests into a sanitized versioned usage result", async () => {
    const deps = dependencies({
      verifyBackup: vi.fn(async () => {
        throw new BackupSchemaError(
          "BACKUP_SCHEMA_INVALID",
          "invalid manifest contains Bearer private-secret",
        );
      }),
    });

    await executeBackupVerify("/bundle/manifest.json", { output: "json" }, deps);

    const emitted = vi.mocked(deps.formatOutput).mock.calls[0]?.[1] as BackupVerifyResult;
    expect(emitted).toMatchObject({
      schemaVersion: "rfapps-backup-verify-result.v1",
      operation: "backup-verify",
      status: "failed",
      success: false,
      exitCode: 2,
      artifacts: [],
    });
    expect(JSON.stringify(emitted)).not.toContain("private-secret");
    expect(process.exitCode).toBe(2);
  });

  it("renders human text without invoking a machine formatter", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = dependencies();

    await executeBackupVerify("/bundle/manifest.json", { output: "text" }, deps);

    expect(deps.formatOutput).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
