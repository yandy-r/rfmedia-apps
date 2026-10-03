/**
 * Type exports for rfapps CLI.
 *
 * Organized into categories:
 * - **options**: Command-line option types (GlobalOptions, DeployOptions, etc.)
 * - **results**: Operation result types (StatusResult, BuildResult, etc.)
 * - **config**: Configuration file types (RfappsConfig, SidecarConfig, etc.)
 * - **plan**: Deployment plan types (DeploymentPlan, ServiceChange, etc.)
 * - **update**: Managed image-update plan and result contracts
 * - **drift**: Drift detection types (DriftResult, ServiceDrift, etc.)
 * - **lint**: Production-readiness lint types (LintResult, LintFinding, etc.)
 * - **security-scan**: Image vulnerability scan contracts (ScanReport, ScanGate, etc.)
 * - **hardening**: Compose security hardening contracts (HardenResult, HardenPatch, etc.)
 * - **doctor**: Unified diagnostic result contracts
 * - **validation**: Versioned pre-deploy conflict validation contracts
 * - **tags**: Hierarchical service tagging contracts (TagPath, TagIndex, TagListResult, etc.)
 *
 * @module rfapps-cli/types
 */

// Option types
export type {
  GlobalOptions,
  ServiceTargetOptions,
  ComposeOptions,
  PullOptions,
  BuildOptions,
  DeployOptions,
  StopOptions,
  RebuildOptions,
  DeleteOptions,
  PruneOptions,
  StatusOptions,
  HealthOptions,
  EnvTool,
  OutputFormat,
  Profile,
  EnvToolExecConfig,
} from "./options.js";

// Helper functions
export { getEnvToolExecConfig } from "./options.js";

// Result types
export type {
  HealthStatus,
  ContainerState,
  ServiceStatus,
  ResourceStats,
  StatusResult,
  PullResult,
  BuildResult,
  DeployResult,
  StopResult,
  RebuildResult,
  DeleteResult,
  PruneResult,
  FailedOperation,
  HealthCommandResult,
} from "./results.js";

// Pre-deploy conflict validation types
export { CONFLICT_VALIDATION_SCHEMA_VERSION } from "./validation.js";
export type {
  ConflictValidationStatus,
  ConflictKind,
  ConflictOrigin,
  ConflictSeverity,
  ConflictValidationCheckKind,
  ConflictValidationCheckStatus,
  ConflictValidationFailureCode,
  ConflictValidationFailure,
  PassedConflictValidationCheck,
  UnavailableConflictValidationCheck,
  ConflictValidationCheck,
  PortAddressFamily,
  PortProtocol,
  PortInterval,
  DesiredPortAllocation,
  DesiredPortClaim,
  RuntimePortClaim,
  DesiredPortConflictParty,
  RuntimePortConflictParty,
  PortConflictParty,
  ConflictMountType,
  ConflictMountProjection,
  DesiredVolumeProjection,
  RuntimeVolumeProjection,
  DesiredVolumeConflictParty,
  RuntimeVolumeConflictParty,
  VolumeConflictParty,
  DesiredNetworkProjection,
  RuntimeNetworkProjection,
  DesiredNetworkConflictParty,
  RuntimeNetworkConflictParty,
  NetworkConflictParty,
  ConflictParty,
  PortConflictResource,
  VolumeConflictResource,
  NetworkConflictResource,
  ConflictResource,
  ServiceConflictCode,
  ChangeComposePortResolution,
  InspectRuntimeOwnerResolution,
  StopOrReconfigureContainerResolution,
  AlignVolumeDefinitionResolution,
  ChangeVolumeMountResolution,
  CreateExternalVolumeResolution,
  ChangeNetworkSubnetResolution,
  RemoveOrReconfigureNetworkResolution,
  ConflictResolution,
  PortServiceConflict,
  VolumeServiceConflict,
  NetworkServiceConflict,
  ServiceConflict,
  ConflictValidationSummary,
  ConflictLimitationCode,
  ConflictLimitation,
  ConflictValidationScope,
  DesiredServiceProjection,
  ConflictDesiredState,
  RuntimeContainerProjection,
  ConflictRuntimeSnapshot,
  ConflictValidationInput,
  PassedConflictValidationResult,
  BlockedConflictValidationResult,
  InconclusiveConflictValidationResult,
  ConflictValidationResult,
} from "./validation.js";

// Config types
export type {
  SidecarConfig,
  GroupConfig,
  ProfileConfig,
  HealthCheckConfig,
  EnvToolConfig,
  DockerConfig,
  RfappsConfig,
  PartialRfappsConfig,
} from "./config.js";

// Hierarchical service tagging types
export {
  TAGS_SCHEMA_VERSION,
  TAG_MAX_DEPTH,
  TAG_MAX_SEGMENT_LENGTH,
  TAG_MAX_LENGTH,
} from "./tags.js";
export type {
  TagPath,
  TagConfig,
  TagPatternElement,
  TagPattern,
  TagTerm,
  TagIndex,
  TagInferenceRuleId,
  TagInferenceConfidence,
  TagProposal,
  TagSuggestResult,
  TagListEntry,
  TagListResult,
  TagShowEntry,
  TagShowResult,
} from "./tags.js";

// Readiness and health types
export type {
  ReadinessProbeType,
  ReadinessProbeStatus,
  DependencyReadinessStatus,
  ReadinessPollSettings,
  DependencyProbeResult,
  DependencyReadinessResult,
  ServiceReadinessResult,
  DependencyReadinessSummary,
} from "./health.js";

// Plan types
export type {
  ChangeType,
  PlanIntent,
  ImageUpdateStatus,
  ImageUpdateCheck,
  ConfigDiff,
  ImageDiff,
  PortMapping,
  VolumeMapping,
  EnvChange,
  ServiceChange,
  PlanSummary,
  DeploymentPlan,
  PlanValidation,
  PlanOptions,
  ApplyResult,
} from "./plan.js";

// Contextual plan intelligence types
export { PLAN_INTELLIGENCE_SCHEMA_VERSION, CHANGE_REASON_CODES } from "./plan-intelligence.js";
export type {
  ChangeReasonCode,
  ChangeReasonKind,
  ReasonConfidence,
  ChangeReason,
  ChangeDimension,
  ServiceEffect,
  ServiceImpact,
  ServiceIntelligence,
  BaselineUnavailableReason,
  PlanProvenance,
  PlanIntelligenceSummary,
  PlanIntelligence,
  PlanBaselineService,
  PlanBaseline,
  PlanBaselineResult,
  PlanIntelligenceInput,
} from "./plan-intelligence.js";

// Managed update types
export {
  MANAGED_UPDATE_PLAN_SCHEMA_VERSION,
  MANAGED_UPDATE_RESULT_SCHEMA_VERSION,
} from "./update.js";
export type {
  ManagedUpdateApplyPolicy,
  ManagedUpdateRestorePolicy,
  ManagedUpdateVerificationPolicy,
  ManagedUpdateReviewedIdentity,
  ManagedUpdatePlanService,
  ManagedUpdatePlan,
  ManagedUpdateStage,
  ManagedUpdateObservedIdentity,
  ManagedUpdateDriftKind,
  ManagedUpdateDriftEvidence,
  ManagedUpdateError,
  ManagedUpdateRuntimeState,
  ManagedUpdateDockerHealth,
  ManagedUpdateVerificationNotRun,
  ManagedUpdateVerificationPassed,
  ManagedUpdateVerificationFailed,
  ManagedUpdateVerificationEvidence,
  ManagedUpdateGenerationEvidence,
  ManagedUpdateRestoreEvidence,
  ManagedUpdateOutcome,
  ManagedUpdateServiceResult,
  ManagedUpdateResultStatus,
  ManagedUpdateExitCode,
  ManagedUpdateSummary,
  ManagedUpdateInterruptionEvidence,
  ManagedUpdateResult,
} from "./update.js";

// Drift types
export type {
  DriftCategory,
  DriftDirection,
  DriftOptions,
  ReconcileDriftOptions,
  DriftCommandOptions,
  RuntimeStatusDrift,
  ServiceDrift,
  DriftSummary,
  DriftResult,
} from "./drift.js";
export { DRIFT_SCHEMA_VERSION } from "./drift.js";

// Reconciliation types
export {
  RECONCILE_MAX_SERVICES,
  RECONCILE_MAX_SERVICE_NAME_LENGTH,
  RECONCILE_SCHEMA_VERSION,
} from "./reconcile.js";
export type {
  ReconcileMode,
  ReconcileComparison,
  ReconcileActionKind,
  ReconcileActionableKind,
  ReconcileEligibility,
  ReconcileOutcome,
  ReconcileStatus,
  ReconcileExitCode,
  ReconcileRuntimeState,
  ReconcileRuntimeHealth,
  ReconcileReason,
  ReconcileEnvironmentDrift,
  ReconcileDriftProjection,
  ReconcileContainerEvidence,
  ReconcileServiceObservation,
  ReconcileAutomationDecision,
  ReconcileScope,
  ReconcilePolicyContext,
  ReconcileAutomationPolicy,
  ReconcileAction,
  ReconcileServiceResult,
  ReconcileSummary,
  ReconcileResult,
} from "./reconcile.js";

// Import (adopt external runtime state) types
export { IMPORT_SCHEMA_VERSION } from "./import.js";
export type {
  ImportMode,
  ImportClassification,
  ImportExitCode,
  ImportServiceResult,
  ImportSummary,
  ImportResult,
} from "./import.js";

// State rebuild / export (state database reconstruction) types
export { STATE_REBUILD_SCHEMA_VERSION, STATE_EXPORT_SCHEMA_VERSION } from "./state-rebuild.js";
export type {
  StateRebuildMode,
  StateRebuildPhase,
  StateRebuildDisposition,
  StateDatabaseStatus,
  StateBackupMethod,
  StateRebuildRefusalReason,
  StateRebuildExitCode,
  StateExportExitCode,
  RawStateRebuildOptions,
  RawStateExportOptions,
  StateCommandGlobalOptions,
  StateDatabaseProbe,
  StateBackupResult,
  CarryOverCounts,
  StateRebuildServiceResult,
  StateRebuildSummary,
  StateRebuildRefusal,
  StateRebuildResult,
  StateExportResult,
} from "./state-rebuild.js";

// Lint types
export type {
  LintSeverity,
  LintFailOn,
  LintMode,
  LintRuleId,
  LintRule,
  LintFindingGroup,
  LintFinding,
  LintSummary,
  LintResult,
  LintOptions,
  LintIgnoreEntry,
  LintComposeResourceLimits,
  LintComposeDeployResources,
  LintComposeRestartPolicy,
  LintComposeDeploy,
  LintComposeHealthcheck,
  LintComposeLogging,
  LintComposeVolumeMount,
  LintComposeService,
  LintComposeConfig,
} from "./lint.js";

// Audit types
export { AUDIT_SCHEMA_VERSION } from "./audit.js";
export type {
  AuditSeverity,
  AuditFailOn,
  AuditCategory,
  AuditRuleId,
  AuditRule,
  AuditFinding,
  AuditSummary,
  AuditScope,
  AuditResult,
  AuditOptions,
  AuditComposeResourceLimits,
  AuditComposeDeployResources,
  AuditComposeDeploy,
  AuditComposeVolumeMount,
  AuditComposeService,
  AuditComposeConfig,
} from "./audit.js";

// Image vulnerability scan types
export { SCAN_SCHEMA_VERSION } from "./security-scan.js";
export type {
  ScannerId,
  ScanSeverity,
  ScanFailOn,
  ScanTarget,
  ScanVulnerability,
  ScanSeverityCounts,
  ScanSkipReason,
  ScanFailureCode,
  ImageScan,
  ScanGateStatus,
  ScanGate,
  ScanSummary,
  ScanScope,
  ScannerIdentity,
  ScanReport,
  ScanSuppression,
  ScanConfig,
  ResolvedScanSettings,
  ScanComposeService,
  ScanComposeConfig,
  ScannerParseResult,
  ScannerBackend,
  SecurityScanDependencies,
} from "./security-scan.js";

// Compose security hardening types
export { HARDEN_SCHEMA_VERSION } from "./hardening.js";
export type {
  HardenSeverity,
  HardenCategory,
  HardenConfidence,
  HardenRuleId,
  HardenMode,
  HardenPatchValue,
  HardenPatchOperation,
  HardenPatch,
  HardenRule,
  HardenProposal,
  HardenRefusalCode,
  HardenRefusal,
  HardenSuppression,
  HardenSummary,
  HardenScope,
  HardenReformat,
  HardenWriteOutcome,
  HardenResult,
  HardenConfig,
  HardenOptions,
  HardenComposeVolumeMount,
  HardenComposeService,
  HardenComposeConfig,
} from "./hardening.js";

// Doctor types
export { DOCTOR_SCHEMA_VERSION } from "./doctor.js";
export type {
  DoctorSeverity,
  DoctorFailOn,
  DoctorCategory,
  DoctorCheckStatus,
  DoctorScope,
  DoctorFinding,
  DoctorCheckResult,
  DoctorSummary,
  DoctorResult,
  DoctorOptions,
  DoctorCheckContext,
} from "./doctor.js";

// Interactive selection types
export type {
  ServiceDisplayInfo,
  InteractiveSelectionOptions,
  InteractiveSelectionResult,
} from "./interactive.js";

// Parallel execution types
export type {
  ParallelConfig,
  ExecutionPhase,
  PhaseResult,
  ParallelExecutionResult,
  DependencyGraph,
} from "./parallel.js";

// Staged rollout types
export type {
  StagedFailurePolicy,
  StagedExecOptions,
  StagedExecutionContext,
  StagedBatch,
  StagedPlan,
  StagedGateReason,
  StagedServiceVerdict,
  StagedGateReport,
  StagedBatchFailureCause,
  StagedBatchPassed,
  StagedBatchFailed,
  StagedBatchSkipped,
  StagedBatchOutcome,
  StagedRolloutStatus,
  StagedRolloutReport,
  StagedRolloutSummary,
  StagedRolloutEvent,
} from "./staged.js";
export { isStagedFailurePolicy } from "./staged.js";

// Native backup types
export {
  BACKUP_MANIFEST_SCHEMA_VERSION,
  BACKUP_RESULT_SCHEMA_VERSION,
  BACKUP_VERIFY_RESULT_SCHEMA_VERSION,
  BACKUP_HELPER_IMAGE_REFERENCE,
} from "./backup.js";
export type {
  BackupExitCode,
  BackupConsistency,
  BackupSkipReasonCode,
  BackupPreflightFailureCode,
  BackupStage,
  BackupConsumer,
  BackupBindSource,
  BackupVolumeSource,
  BackupSource,
  BackupSourceProbeResult,
  BackupBindMountIdentity,
  BackupBindTopologyEntry,
  BackupBindTopologyProbeResult,
  BackupBindRestoreHint,
  BackupVolumeRestoreHint,
  BackupRestoreHint,
  BackupManifestMount,
  BackupSkippedSource,
  BackupWarning,
  BackupPreflightError,
  BackupOperationalError,
  BackupError,
  BackupManifest,
  BackupPlannedMount,
  BackupPlan,
  BackupPlannedArtifactOutcome,
  BackupArchivedArtifactOutcome,
  BackupFailedArtifactOutcome,
  BackupArtifactOutcome,
  BackupRecoveryFailure,
  BackupStagingDisposition,
  BackupSummary,
  BackupResultStatus,
  BackupDryRunResult,
  BackupPublishedResult,
  BackupFailedDryRunResult,
  BackupRealUnsuccessfulStaging,
  BackupFailedResult,
  BackupCancelledResult,
  BackupResult,
  BackupArtifactVerificationStatus,
  BackupVerifiedArtifact,
  BackupMissingArtifact,
  BackupSizeMismatchArtifact,
  BackupChecksumMismatchArtifact,
  BackupUnexpectedArtifact,
  BackupArtifactVerification,
  BackupVerifySummary,
  BackupVerifyResultStatus,
  BackupVerifiedResult,
  BackupIntegrityFailureResult,
  BackupVerifyResult,
} from "./backup.js";

// State types
export type {
  DeploymentAction,
  DeploymentStatus,
  ConfigSnapshot,
  StateEntry,
  StateEntryRow,
  StateEntryInput,
  GenerationAction,
  GenerationEntry,
  GenerationRow,
  GenerationInput,
  GenerationsOptions,
  GenerationsResult,
  HistoryOptions,
  RollbackOptions,
  StateConfig,
  RollbackWarning,
  RollbackResult,
  HistoryResult,
} from "./state.js";
