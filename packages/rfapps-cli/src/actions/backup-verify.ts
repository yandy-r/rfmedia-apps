import { dirname, resolve } from "node:path";

import type { OutputFormat } from "@rfmedia/common";

import { BackupSchemaError } from "../lib/backup-schema.js";
import { BackupStorageError } from "../lib/backup-storage.js";
import { verifyBackup } from "../lib/backup-verify.js";
import { InvalidArgumentError } from "../lib/errors.js";
import { setExitCode } from "../lib/exit-codes.js";
import { formatOutput } from "../lib/formatters/index.js";
import {
  BACKUP_VERIFY_RESULT_SCHEMA_VERSION,
  type BackupError,
  type BackupVerifyResult,
} from "../types/backup.js";

export interface BackupVerifyGlobalOptions {
  readonly json?: boolean;
  readonly output?: OutputFormat;
}

export interface BackupVerifyActionDependencies {
  verifyBackup: typeof verifyBackup;
  formatOutput: typeof formatOutput;
}

const defaultDependencies: BackupVerifyActionDependencies = {
  verifyBackup,
  formatOutput,
};

function resolvedFormat(options: BackupVerifyGlobalOptions): OutputFormat {
  return options.output ?? (options.json === true ? "json" : "text");
}

function failureResult(inputManifestPath: string, error: unknown): BackupVerifyResult {
  const manifestPath = resolve(inputManifestPath);
  const schemaFailure = error instanceof BackupSchemaError;
  const storageFailure = error instanceof BackupStorageError;
  const usageFailure = schemaFailure || (storageFailure && error.code !== "BACKUP_STORAGE_IO");
  const failure: BackupError = {
    kind: "operational",
    stage: "verify",
    code: schemaFailure ? error.code : storageFailure ? error.code : "BACKUP_VERIFY_FAILED",
    message: usageFailure
      ? "Backup manifest is invalid, unsupported, or unsafe"
      : "Backup verification could not be completed",
  };
  return {
    schemaVersion: BACKUP_VERIFY_RESULT_SCHEMA_VERSION,
    operation: "backup-verify",
    status: "failed",
    success: false,
    exitCode: usageFailure ? 2 : 1,
    dryRun: false,
    manifestPath,
    bundlePath: dirname(manifestPath),
    artifacts: [],
    warnings: [],
    errors: [failure],
    summary: {
      declaredArtifacts: 0,
      verifiedArtifacts: 0,
      unexpectedArtifacts: 0,
      missingArtifacts: 0,
      unsafeArtifacts: usageFailure ? 1 : 0,
      sizeMismatches: 0,
      checksumMismatches: 0,
    },
  };
}

function renderVerifyResult(result: BackupVerifyResult): void {
  console.error(`Backup verification: ${result.status}`);
  console.error(`Manifest: ${result.manifestPath}`);
  console.error(`Bundle: ${result.bundlePath}`);
  console.error(
    `Artifacts: ${result.summary.verifiedArtifacts}/${result.summary.declaredArtifacts} verified`,
  );
  for (const artifact of result.artifacts) {
    console.error(`  ${artifact.artifactPath}: ${artifact.status}`);
  }
  for (const error of result.errors) {
    console.error(`  ${error.code}: ${error.message}`);
  }
}

/** Verify one bundle without loading configuration, Docker, selection, or locks. */
export async function executeBackupVerify(
  inputManifestPath: string,
  globalOptions: BackupVerifyGlobalOptions,
  dependencies: BackupVerifyActionDependencies = defaultDependencies,
): Promise<void> {
  const format = resolvedFormat(globalOptions);
  if (format === "csv") {
    throw new InvalidArgumentError(
      "--output",
      "csv",
      "CSV output cannot represent backup integrity evidence",
      ["json", "yaml", "table", "text"],
    );
  }

  let result: BackupVerifyResult;
  try {
    result = await dependencies.verifyBackup(inputManifestPath);
  } catch (error) {
    result = failureResult(inputManifestPath, error);
  }

  if (format === "text" || format === "table") {
    renderVerifyResult(result);
  } else {
    await dependencies.formatOutput(format, result);
  }
  if (result.exitCode !== 0) setExitCode(result.exitCode);
}
