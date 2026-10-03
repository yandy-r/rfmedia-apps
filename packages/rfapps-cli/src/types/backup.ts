/**
 * Public contracts for native filesystem backup creation and verification.
 */

export const BACKUP_MANIFEST_SCHEMA_VERSION = "rfapps-backup.v1" as const;
export const BACKUP_RESULT_SCHEMA_VERSION = "rfapps-backup-result.v1" as const;
export const BACKUP_VERIFY_RESULT_SCHEMA_VERSION = "rfapps-backup-verify-result.v1" as const;

export const BACKUP_HELPER_IMAGE_REFERENCE =
  "docker.io/library/alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1" as const;

export type BackupExitCode = 0 | 1 | 2;
export type BackupConsistency = "detected-compose-writers-stopped";

export type BackupSkipReasonCode =
  | "NON_PERSISTENT_TMPFS"
  | "HOST_SYSTEM_PATH"
  | "SOCKET_SOURCE"
  | "DEVICE_SOURCE"
  | "READ_ONLY_SYSTEM_FILE";

export type BackupPreflightFailureCode =
  | "ANONYMOUS_VOLUME"
  | "UNSUPPORTED_MOUNT_TYPE"
  | "BIND_SOURCE_MISSING"
  | "BIND_SOURCE_NOT_DIRECTORY"
  | "NAMED_VOLUME_MISSING"
  | "NESTED_SELECTED_BIND"
  | "AMBIGUOUS_BIND_PATH"
  | "DESTINATION_INSIDE_SOURCE"
  | "SOURCE_PROBE_FAILED";

export type BackupStage =
  | "validate"
  | "plan"
  | "reserve"
  | "prepare-helper"
  | "lock"
  | "revalidate"
  | "observe"
  | "stop"
  | "archive"
  | "recover"
  | "publish"
  | "verify"
  | "cleanup"
  | "cancelled";

export interface BackupConsumer {
  service: string;
  target: string;
  readOnly: boolean;
}

export interface BackupBindSource {
  kind: "bind";
  path: string;
}

export interface BackupVolumeSource {
  kind: "volume";
  name: string;
  driver: string;
  external: boolean;
}

export type BackupSource = BackupBindSource | BackupVolumeSource;

export type BackupSourceProbeResult =
  | { readonly status: "available" }
  | { readonly status: "missing" }
  | {
      readonly status: "not-directory";
      readonly kind: "file" | "socket" | "device" | "other";
    };

export interface BackupBindMountIdentity {
  readonly majorMinor: string;
  readonly mountRoot: string;
}

export interface BackupBindTopologyEntry extends BackupBindMountIdentity {
  readonly sourcePath: string;
}

export interface BackupBindTopologyProbeResult {
  readonly entries: readonly BackupBindTopologyEntry[];
  readonly fingerprint: string;
}

export interface BackupBindRestoreHint {
  kind: "bind-tar";
  destinationPath: string;
  precondition: "writers-stopped";
}

export interface BackupVolumeRestoreHint {
  kind: "volume-tar";
  volumeName: string;
  driver: string;
  external: boolean;
  precondition: "writers-stopped";
}

export type BackupRestoreHint = BackupBindRestoreHint | BackupVolumeRestoreHint;

export interface BackupManifestMount {
  id: string;
  artifactPath: string;
  source: BackupSource;
  consumers: BackupConsumer[];
  archiveStartedAt: string;
  archiveCompletedAt: string;
  compressedBytes: number;
  sha256: string;
  restore: BackupRestoreHint;
}

export interface BackupSkippedSource {
  id: string;
  mountType: string;
  reasonCode: BackupSkipReasonCode;
  source?: string;
  consumers: BackupConsumer[];
}

export interface BackupWarning {
  code: string;
  message: string;
}

export interface BackupPreflightError {
  kind: "preflight";
  stage: "validate" | "plan";
  code: BackupPreflightFailureCode;
  message: string;
}

export interface BackupOperationalError {
  kind: "operational";
  stage: BackupStage;
  code: string;
  message: string;
}

export type BackupError = BackupPreflightError | BackupOperationalError;

export interface BackupManifest {
  schemaVersion: typeof BACKUP_MANIFEST_SCHEMA_VERSION;
  backupId: string;
  createdAt: string;
  completedAt: string;
  consistency: BackupConsistency;
  project: {
    name: string;
    resolvedConfigSha256: string;
    dockerAuthorityFingerprint: string;
  };
  scope: {
    requestedServices: string[];
    resolvedServices: string[];
    quiescedServices: string[];
    previouslyRunningServices: string[];
  };
  helperImage: {
    reference: typeof BACKUP_HELPER_IMAGE_REFERENCE;
    resolvedImageId: string;
  };
  skipped: BackupSkippedSource[];
  mounts: BackupManifestMount[];
  warnings: BackupWarning[];
}

export interface BackupPlannedMount {
  id: string;
  artifactPath: string;
  source: BackupSource;
  consumers: BackupConsumer[];
  writerServices: string[];
  restore: BackupRestoreHint;
}

export interface BackupPlan {
  requestedServices: string[];
  resolvedServices: string[];
  quiescedServices: string[];
  recoveryLayers: string[][];
  mounts: BackupPlannedMount[];
  skipped: BackupSkippedSource[];
  warnings: BackupWarning[];
  resolvedConfigSha256: string;
  dockerAuthorityFingerprint: string;
  bindTopologyFingerprint: string;
  canonicalDestination: string;
}

export interface BackupPlannedArtifactOutcome {
  id: string;
  artifactPath: string;
  status: "planned";
  compressedBytes?: never;
  sha256?: never;
  error?: never;
}

export interface BackupArchivedArtifactOutcome {
  id: string;
  artifactPath: string;
  status: "archived";
  compressedBytes: number;
  sha256: string;
  error?: never;
}

export interface BackupFailedArtifactOutcome {
  id: string;
  artifactPath: string;
  status: "failed";
  compressedBytes?: never;
  sha256?: never;
  error: BackupError;
}

export type BackupArtifactOutcome =
  | BackupPlannedArtifactOutcome
  | BackupArchivedArtifactOutcome
  | BackupFailedArtifactOutcome;

export interface BackupRecoveryFailure {
  containerId: string;
  service: string;
  code: string;
  message: string;
}

export type BackupStagingDisposition = "none" | "removed" | "published" | "retained-incomplete";

export interface BackupSummary {
  requestedServices: number;
  resolvedServices: number;
  writerServices: number;
  previouslyRunningContainers: number;
  plannedArtifacts: number;
  archivedArtifacts: number;
  skippedSources: number;
  failedArtifacts: number;
  recoveryFailures: number;
}

export type BackupResultStatus = "planned" | "succeeded" | "failed" | "cancelled";

interface BackupResultBase {
  schemaVersion: typeof BACKUP_RESULT_SCHEMA_VERSION;
  operation: "backup";
  backupId: string;
  startedAt: string;
  completedAt: string;
  requestedServices: string[];
  resolvedServices: string[];
  writerServices: string[];
  previouslyRunningContainerIds: string[];
  destinationPath: string;
  planned: BackupPlannedMount[];
  skipped: BackupSkippedSource[];
  warnings: BackupWarning[];
  summary: BackupSummary;
}

export interface BackupDryRunResult extends BackupResultBase {
  status: "planned";
  success: true;
  exitCode: 0;
  dryRun: true;
  bundlePath?: never;
  manifestPath?: never;
  artifacts: BackupPlannedArtifactOutcome[];
  errors: [];
  primaryFailure?: never;
  recoveryFailures: [];
  stagingDisposition: "none";
}

export interface BackupPublishedResult extends BackupResultBase {
  status: "succeeded";
  success: true;
  exitCode: 0;
  dryRun: false;
  bundlePath: string;
  manifestPath: string;
  artifacts: BackupArchivedArtifactOutcome[];
  errors: [];
  primaryFailure?: never;
  recoveryFailures: [];
  stagingDisposition: "published";
}

interface BackupUnsuccessfulResultBase extends BackupResultBase {
  status: "failed" | "cancelled";
  success: false;
  exitCode: 1 | 2;
  artifacts: BackupArtifactOutcome[];
  errors: [BackupError, ...BackupError[]];
  primaryFailure: BackupError;
}

export interface BackupFailedDryRunResult extends BackupUnsuccessfulResultBase {
  status: "failed";
  exitCode: 1 | 2;
  dryRun: true;
  stagingDisposition: "none";
  bundlePath?: never;
  recoveryFailures: [];
}

export type BackupRealUnsuccessfulStaging =
  | {
      stagingDisposition: "none" | "removed";
      bundlePath?: never;
      manifestPath?: never;
      recoveryFailures: [];
    }
  | {
      stagingDisposition: "retained-incomplete";
      bundlePath: string;
      manifestPath?: never;
      recoveryFailures: BackupRecoveryFailure[];
    }
  | {
      stagingDisposition: "published";
      bundlePath: string;
      manifestPath: string;
      recoveryFailures: BackupRecoveryFailure[];
    };

export type BackupFailedResult = BackupUnsuccessfulResultBase &
  BackupRealUnsuccessfulStaging & {
    status: "failed";
    exitCode: 1 | 2;
    dryRun: false;
  };

export type BackupCancelledResult = BackupUnsuccessfulResultBase &
  BackupRealUnsuccessfulStaging & {
    status: "cancelled";
    exitCode: 2;
    dryRun: false;
  };

export type BackupResult =
  | BackupDryRunResult
  | BackupPublishedResult
  | BackupFailedDryRunResult
  | BackupFailedResult
  | BackupCancelledResult;

export type BackupArtifactVerificationStatus =
  | "verified"
  | "missing"
  | "unsafe"
  | "not-regular"
  | "size-mismatch"
  | "checksum-mismatch"
  | "unexpected";

interface BackupDeclaredArtifactVerificationBase {
  id: string;
  artifactPath: string;
  expectedBytes: number;
  expectedSha256: string;
}

export interface BackupVerifiedArtifact extends BackupDeclaredArtifactVerificationBase {
  status: "verified";
  actualBytes: number;
  actualSha256: string;
  error?: never;
}

export interface BackupMissingArtifact extends BackupDeclaredArtifactVerificationBase {
  status: "missing" | "unsafe" | "not-regular";
  actualBytes?: never;
  actualSha256?: never;
  error: BackupError;
}

export interface BackupSizeMismatchArtifact extends BackupDeclaredArtifactVerificationBase {
  status: "size-mismatch";
  actualBytes: number;
  actualSha256?: never;
  error: BackupError;
}

export interface BackupChecksumMismatchArtifact extends BackupDeclaredArtifactVerificationBase {
  status: "checksum-mismatch";
  actualBytes: number;
  actualSha256: string;
  error: BackupError;
}

export interface BackupUnexpectedArtifact {
  id?: never;
  artifactPath: string;
  status: "unexpected";
  expectedBytes?: never;
  actualBytes?: number;
  expectedSha256?: never;
  actualSha256?: string;
  error: BackupError;
}

export type BackupArtifactVerification =
  | BackupVerifiedArtifact
  | BackupMissingArtifact
  | BackupSizeMismatchArtifact
  | BackupChecksumMismatchArtifact
  | BackupUnexpectedArtifact;

export interface BackupVerifySummary {
  declaredArtifacts: number;
  verifiedArtifacts: number;
  unexpectedArtifacts: number;
  missingArtifacts: number;
  unsafeArtifacts: number;
  sizeMismatches: number;
  checksumMismatches: number;
}

export type BackupVerifyResultStatus = "succeeded" | "failed";

interface BackupVerifyResultBase {
  schemaVersion: typeof BACKUP_VERIFY_RESULT_SCHEMA_VERSION;
  operation: "backup-verify";
  dryRun: false;
  manifestPath: string;
  bundlePath: string;
  warnings: BackupWarning[];
  summary: BackupVerifySummary;
}

export interface BackupVerifiedResult extends BackupVerifyResultBase {
  status: "succeeded";
  success: true;
  exitCode: 0;
  artifacts: BackupVerifiedArtifact[];
  errors: [];
}

export interface BackupIntegrityFailureResult extends BackupVerifyResultBase {
  status: "failed";
  success: false;
  exitCode: 1 | 2;
  artifacts: BackupArtifactVerification[];
  errors: [BackupError, ...BackupError[]];
}

export type BackupVerifyResult = BackupVerifiedResult | BackupIntegrityFailureResult;
