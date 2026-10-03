import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import {
  BACKUP_VERIFY_RESULT_SCHEMA_VERSION,
  type BackupArtifactVerification,
  type BackupError,
  type BackupManifestMount,
  type BackupVerifiedArtifact,
  type BackupVerifyResult,
  type BackupVerifySummary,
} from "../types/backup.js";
import {
  BackupStorageError,
  listBackupRegularArtifacts,
  openBackupRegularFile,
  readBackupManifest,
  revalidateBackupRegularFile,
} from "./backup-storage.js";

interface ArtifactDigest {
  readonly bytes: number;
  readonly sha256: string;
}

function verifyError(code: string, message: string): BackupError {
  return {
    kind: "operational",
    stage: "verify",
    code,
    message: message.slice(0, 4_096),
  };
}

async function digestOpenedArtifact(
  opened: Awaited<ReturnType<typeof openBackupRegularFile>>,
): Promise<ArtifactDigest> {
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = opened.handle.createReadStream({ autoClose: false });
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      hash.update(buffer);
    }
    await revalidateBackupRegularFile(opened);
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    stream.destroy();
    await opened.handle.close().catch(() => undefined);
  }
}

function storageFailureOutcome(
  mount: BackupManifestMount,
  error: BackupStorageError,
): BackupArtifactVerification {
  switch (error.code) {
    case "BACKUP_PATH_NOT_FOUND":
      return {
        id: mount.id,
        artifactPath: mount.artifactPath,
        status: "missing",
        expectedBytes: mount.compressedBytes,
        expectedSha256: mount.sha256,
        error: verifyError("BACKUP_ARTIFACT_MISSING", "Declared backup artifact is missing"),
      };
    case "BACKUP_FILE_NOT_REGULAR":
      return {
        id: mount.id,
        artifactPath: mount.artifactPath,
        status: "not-regular",
        expectedBytes: mount.compressedBytes,
        expectedSha256: mount.sha256,
        error: verifyError(
          "BACKUP_ARTIFACT_NOT_REGULAR",
          "Declared backup artifact is not a regular file",
        ),
      };
    default:
      return {
        id: mount.id,
        artifactPath: mount.artifactPath,
        status: "unsafe",
        expectedBytes: mount.compressedBytes,
        expectedSha256: mount.sha256,
        error: verifyError(
          "BACKUP_ARTIFACT_UNSAFE",
          "Declared backup artifact could not be opened safely",
        ),
      };
  }
}

async function verifyMount(
  bundlePath: string,
  mount: BackupManifestMount,
): Promise<BackupArtifactVerification> {
  let opened: Awaited<ReturnType<typeof openBackupRegularFile>>;
  try {
    opened = await openBackupRegularFile(join(bundlePath, mount.artifactPath));
  } catch (error: unknown) {
    if (error instanceof BackupStorageError) return storageFailureOutcome(mount, error);
    throw error;
  }

  if (opened.size !== mount.compressedBytes) {
    await opened.handle.close().catch(() => undefined);
    return {
      id: mount.id,
      artifactPath: mount.artifactPath,
      status: "size-mismatch",
      expectedBytes: mount.compressedBytes,
      actualBytes: opened.size,
      expectedSha256: mount.sha256,
      error: verifyError("BACKUP_ARTIFACT_SIZE_MISMATCH", "Backup artifact size does not match"),
    };
  }

  let actual: ArtifactDigest;
  try {
    actual = await digestOpenedArtifact(opened);
  } catch (error: unknown) {
    if (error instanceof BackupStorageError) return storageFailureOutcome(mount, error);
    return {
      id: mount.id,
      artifactPath: mount.artifactPath,
      status: "unsafe",
      expectedBytes: mount.compressedBytes,
      expectedSha256: mount.sha256,
      error: verifyError("BACKUP_ARTIFACT_READ_FAILED", "Backup artifact could not be read safely"),
    };
  }

  if (actual.sha256 !== mount.sha256) {
    return {
      id: mount.id,
      artifactPath: mount.artifactPath,
      status: "checksum-mismatch",
      expectedBytes: mount.compressedBytes,
      actualBytes: actual.bytes,
      expectedSha256: mount.sha256,
      actualSha256: actual.sha256,
      error: verifyError(
        "BACKUP_ARTIFACT_CHECKSUM_MISMATCH",
        "Backup artifact checksum does not match",
      ),
    };
  }
  return {
    id: mount.id,
    artifactPath: mount.artifactPath,
    status: "verified",
    expectedBytes: mount.compressedBytes,
    actualBytes: actual.bytes,
    expectedSha256: mount.sha256,
    actualSha256: actual.sha256,
  };
}

function summarize(artifacts: readonly BackupArtifactVerification[]): BackupVerifySummary {
  return {
    declaredArtifacts: artifacts.filter(({ status }) => status !== "unexpected").length,
    verifiedArtifacts: artifacts.filter(({ status }) => status === "verified").length,
    unexpectedArtifacts: artifacts.filter(({ status }) => status === "unexpected").length,
    missingArtifacts: artifacts.filter(({ status }) => status === "missing").length,
    unsafeArtifacts: artifacts.filter(({ status }) => status === "unsafe").length,
    sizeMismatches: artifacts.filter(({ status }) => status === "size-mismatch").length,
    checksumMismatches: artifacts.filter(({ status }) => status === "checksum-mismatch").length,
  };
}

function isVerifiedArtifact(
  artifact: BackupArtifactVerification,
): artifact is BackupVerifiedArtifact {
  return artifact.status === "verified";
}

export async function verifyBackup(inputManifestPath: string): Promise<BackupVerifyResult> {
  const { manifest, manifestPath } = await readBackupManifest(inputManifestPath);
  const bundlePath = dirname(manifestPath);
  const declared = [...manifest.mounts].sort((left, right) =>
    left.artifactPath < right.artifactPath ? -1 : left.artifactPath > right.artifactPath ? 1 : 0,
  );
  const declaredOutcomes: BackupArtifactVerification[] = [];
  for (const mount of declared) {
    declaredOutcomes.push(await verifyMount(bundlePath, mount));
  }

  const declaredPaths = new Set(declared.map(({ artifactPath }) => artifactPath));
  const unexpected = (await listBackupRegularArtifacts(bundlePath))
    .filter((artifactPath) => !declaredPaths.has(artifactPath))
    .map(
      (artifactPath): BackupArtifactVerification => ({
        artifactPath,
        status: "unexpected",
        error: verifyError(
          "BACKUP_ARTIFACT_UNEXPECTED",
          "Bundle contains an undeclared regular artifact",
        ),
      }),
    );
  const artifacts = [...declaredOutcomes, ...unexpected];
  const summary = summarize(artifacts);
  const errors = artifacts.flatMap((artifact) =>
    artifact.error === undefined ? [] : [artifact.error],
  );
  const unsafe = errors.some(({ code }) => code === "BACKUP_ARTIFACT_UNSAFE");
  const firstError = errors[0];

  const base = {
    schemaVersion: BACKUP_VERIFY_RESULT_SCHEMA_VERSION,
    operation: "backup-verify" as const,
    dryRun: false as const,
    manifestPath,
    bundlePath,
    artifacts,
    warnings: manifest.warnings.map((warning) => ({ ...warning })),
    summary,
  };
  if (firstError === undefined) {
    const verifiedArtifacts = artifacts.filter(isVerifiedArtifact);
    if (verifiedArtifacts.length !== artifacts.length) {
      throw new Error("Backup verification produced a failure without an error");
    }
    return {
      ...base,
      artifacts: verifiedArtifacts,
      status: "succeeded",
      success: true,
      exitCode: 0,
      errors: [],
    };
  }
  return {
    ...base,
    status: "failed",
    success: false,
    exitCode: unsafe ? 2 : 1,
    errors: [firstError, ...errors.slice(1)],
  };
}
