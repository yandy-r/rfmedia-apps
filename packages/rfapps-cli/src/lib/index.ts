/**
 * Library exports for rfapps CLI.
 *
 * This module provides all internal utilities used by rfapps actions:
 *
 * - **services**: Sidecar linking, service groups, profile detection
 * - **docker**: Docker command execution with retry logic
 * - **env-tools**: dotenvx/1Password secrets injection
 * - **config**: Configuration loading and merging
 * - **validation**: Compose file and config validation
 * - **selector**: The unified `-s`/`--services`/`-g`/`--tag` targeting axis
 * - **command-options**: Shared Commander declarations for service-targeting flags
 * - **tags**: Hierarchical tag grammar, index, suggestions, and inference
 * - **plan-generator**: Deployment plan generation
 * - **plan-storage**: Plan persistence and validation
 * - **drift**: Configuration drift detection
 *
 * @module rfapps-cli/lib
 */

// Service utilities (now config-driven, no hardcoded constants)
export {
  getSidecarForService,
  getMainServicesForSidecar,
  isSidecar,
  getProfileForService,
  expandServiceGroup,
  getAvailableGroups,
  expandServicesWithSidecars,
  autoDetectProfiles,
  isValidProfile,
} from "./services.js";

// Docker execution utilities
export {
  execDocker,
  execDockerCompose,
  listContainers,
  getContainerStats,
  pullImages,
  buildImages,
  startServices,
  stopServices,
  downServices,
  removeServices,
  pruneImages,
  pruneVolumes,
  validateComposeFile,
  getComposeServices,
  getRunningContainers,
  getRunningServiceContainerMap,
  getComposeContainerObservations,
  reconcileService,
  getComposeConfig,
  getCanonicalComposeConfig,
  getCanonicalComposeConfigEvidence,
  getConflictRuntimeContainers,
  getConflictRuntimeNetworks,
  getConflictRuntimeVolumes,
  getComposeServiceDependencies,
  removeImage,
  isImageInUse,
  imageExists,
  filterToolOutput,
  getLocalImageDigest,
  getRemoteImageDigest,
  checkImageUpdate,
  DockerEvidenceError,
} from "./docker.js";

export type {
  DockerExecOptions,
  DockerExecResult,
  ComposeServiceConfig,
  CanonicalComposePortConfig,
  CanonicalComposeMountConfig,
  CanonicalComposeServiceConfig,
  CanonicalComposeVolumeConfig,
  CanonicalComposeNetworkIpamConfig,
  CanonicalComposeNetworkConfig,
  CanonicalComposeConfig,
  CanonicalComposeConfigEvidence,
  ConflictEvidenceOptions,
  ContainerInspect,
  ServiceContainerEntry,
  ComposeContainerObservation,
  ComposeContainerObservationOptions,
  ReconcileServiceAction,
  ReconcileServiceInput,
  ImageUpdateCheck,
} from "./docker.js";

// Add inspectContainers export
export { inspectContainers } from "./docker.js";

// Environment tool utilities
export {
  checkDotenvx,
  checkOp,
  checkEnvTool,
  envFileExists,
  buildEnvCommand,
  execWithEnv,
  autoDetectEnvTool,
  validateEnvToolConfig,
} from "./env-tools.js";

export type { EnvToolOptions, ToolCheckResult } from "./env-tools.js";

// Configuration utilities
export {
  loadConfig,
  applyCliOverrides,
  validateConfig,
  generateSampleConfig,
  getProjectConfigPath,
  getDefaultConfigPath,
  getStateDbPath,
} from "./config.js";

// Validation utilities
export {
  validateConfigAgainstCompose,
  parseComposeFile,
  clearValidationCache,
  validateSidecarReferences,
  validateGroupReferences,
  validateProfileMappings,
  findUndefinedServices,
  findOrphanedServices,
  formatValidationWarnings,
  hasErrors,
  validateServiceNames,
  validateTagReferences,
  validateTagLayerOwnership,
} from "./validation.js";

export type { ValidationWarning } from "./validation.js";

// Unified service-targeting selector (`-s`, `--services`, `-g`, `--tag`)
export {
  applyTagAxis,
  describeSelector,
  explicitSelectorFlagNames,
  hasExplicitSelector,
  hasServicesSelector,
} from "./selector.js";

export type { SelectorFlags, TagAxis } from "./selector.js";

// Shared Commander option declarations for service-targeting commands
export { addServiceTargetOptions } from "./command-options.js";

export type { ServiceTargetOptionsConfig } from "./command-options.js";

// Hierarchical service tagging: grammar, index, suggestions, and inference
export {
  TAG_INFERENCE_RULES,
  TAG_INFERENCE_RULE_IDS,
  TAG_SEGMENT_PATTERN,
  buildTagIndex,
  compareTags,
  findClosestTag,
  getTagIndex,
  inferTags,
  invalidSegmentReason,
  isValidTagSegment,
  normalizeTag,
  parseTagPattern,
  parseTagTerm,
  readComposeLabels,
  renderTagFragment,
  segmentTooLongReason,
  serviceMatches,
  tagAncestors,
  tagMatches,
} from "./tags/index.js";

export type {
  TagFragmentOptions,
  TagIndexBuild,
  TagIndexInput,
  TagInferenceComposeConfig,
  TagInferenceComposeService,
  TagInferenceContext,
  TagInferenceOptions,
  TagInferenceRule,
  TagInputOrigin,
  TagNormalizationWarning,
} from "./tags/index.js";

// Pre-deploy conflict validation
export { evaluateConflictValidation, formatConflictValidationText } from "./conflict-validation.js";

// Plan utilities
export { generatePlan } from "./plan-generator.js";
export { generateManagedUpdatePlan, runManagedUpdate } from "./managed-update.js";
export type {
  GenerateManagedUpdatePlanInput,
  RunManagedUpdateOptions,
  ManagedUpdateDependencies,
  ManagedUpdatePlanDependencies,
  ManagedUpdateDockerDependencies,
  ManagedUpdateStateDependencies,
  ManagedUpdateHealthDependencies,
  ManagedUpdateClockDependencies,
  ManagedUpdateLockDependencies,
  ManagedUpdateSignalDependencies,
  ManagedUpdateFilesystemDependencies,
} from "./managed-update.js";

// Native backup schema, planning, coordination, and offline verification
export {
  MAX_BACKUP_MANIFEST_BYTES,
  MAX_BACKUP_MANIFEST_ENTRIES,
  MAX_BACKUP_MANIFEST_WARNINGS,
  MAX_BACKUP_STRING_BYTES,
  BackupSchemaError,
  validateBackupManifest,
  parseBackupManifestJson,
} from "./backup-schema.js";
export type { BackupSchemaErrorCode } from "./backup-schema.js";
export { BackupPlannerError, planBackup } from "./backup-planner.js";
export type {
  BackupPlannerErrorCode,
  BackupPlannerDependencies,
  BackupPlannerInput,
} from "./backup-planner.js";
export type { BackupSourceProbeResult } from "../types/backup.js";
export { runBackup } from "./backup-coordinator.js";
export type { RunBackupInput, BackupCoordinatorDependencies } from "./backup-coordinator.js";
export { verifyBackup } from "./backup-verify.js";

export {
  savePlan,
  loadPlan,
  validatePlan,
  listPlans,
  deletePlan,
  hashFile,
} from "./plan-storage.js";

// Contextual plan annotations (`rfapps plan --explain`)
export { buildPlanIntelligence } from "./plan-intelligence.js";
export { loadPlanBaseline } from "./plan-baseline.js";

// Drift utilities
export { detectDrift, getDriftForService, formatDriftDiff, hasImportableDrift } from "./drift.js";

// Reconciliation coordinator and authority utilities
export { runReconcile } from "./reconcile.js";
export { dockerAuthorityFingerprint, resolveComposeProjectIdentity } from "./identity.js";
export type { ComposeProjectIdentity, ResolveComposeProjectIdentityOptions } from "./identity.js";
export { resolveReconcileExitCode } from "./exit-codes.js";

// Lint utilities
export { evaluateLint, LINT_RULES } from "./lint.js";
export { toSarif } from "./lint-sarif.js";

// Security audit utilities
export {
  AUDIT_RULES,
  buildAuditSummary,
  compareAuditSeverity,
  evaluateSecurityAudit,
  formatAuditText,
  parseAuditFailOn,
  shouldFailAudit,
  sortAuditFindings,
} from "./security-audit.js";

// Image vulnerability scanning utilities
export {
  SCANNER_BACKENDS,
  SCANNER_IDS,
  SCAN_SEVERITY_RANK,
  buildScanSummary,
  evaluateScanGate,
  formatScanText,
  normalizeScanSuppressions,
  parseScanFailOn,
  resolveScanSettings,
  resolveScanTargets,
  resolveScannerBackend,
  runSecurityScan,
} from "./security-scan.js";

// Compose security hardening utilities
export {
  HARDEN_RULES,
  HARDEN_RULE_IDS,
  applyHardenPatches,
  buildHardenOverride,
  buildHardenSummary,
  detectReformat,
  evaluateHardening,
  filterWritableProposals,
  formatHardenRulesCatalog,
  formatHardenText,
  normalizeHardenSuppressions,
  parseHardenRuleIds,
  serializeComposeDocument,
} from "./hardening.js";

// Doctor utilities
export {
  buildDoctorSummary,
  compareDoctorSeverity,
  createSkippedCheck,
  formatDoctorText,
  parseDoctorFailOn,
  runDoctorChecks,
  shouldFailDoctor,
  sortDoctorFindings,
} from "./doctor/index.js";
export type { DoctorCheckerResult } from "./doctor/index.js";

// Service status utilities
export { getServiceStatusMap } from "./service-status.js";
export type { ServiceStatusEntry } from "./service-status.js";

// Dependency readiness utilities
export { waitForDependencyReadiness } from "./health.js";
export type { WaitForDependencyReadinessOptions } from "./health.js";

// Interactive mode detection utilities
export { isInteractiveEnvironment, shouldShowInteractiveSelection } from "./interactive-check.js";

// Interactive service selection UI
export { selectServicesInteractive } from "./interactive.js";

// Interactive service resolution helper
export { resolveServicesWithInteractive } from "./interactive-selection.js";

// Database utilities
export {
  getDefaultDatabasePath,
  initializeDatabase,
  closeDatabase,
  getCurrentSchemaVersion,
  updateSchemaVersion,
} from "./db.js";

export type { DbConnection } from "./db.js";

// Migration utilities
export { CURRENT_SCHEMA_VERSION, runMigrations } from "./migrations.js";

// State storage utilities
export {
  recordDeployment,
  recordDeployments,
  updateDeploymentStatus,
  getDeployment,
  getLatestDeployment,
  maskSensitiveEnvVars,
  GENERATION_ACTIONS,
} from "./state-storage.js";

// State database reconstruction primitives
export {
  probeStateDatabase,
  openReadOnlyStateDatabase,
  readLatestRecordedImageIds,
  backupStateDatabase,
  buildReplacementDatabasePath,
  defaultBackupPath,
  carryOverState,
  swapStateDatabase,
} from "./state-rebuild.js";

// Shared runtime observation engine (container -> state row)
export {
  buildConfigSnapshotFromInspect,
  captureRuntimeBaseline,
  toBaselineEntry,
} from "./runtime-baseline.js";
export type { RuntimeBaseline } from "./runtime-baseline.js";

// State query utilities
export {
  getDeploymentHistory,
  findRollbackTarget,
  findDeploymentById,
  getSuccessfulDeploymentCount,
  getDeploymentCount,
} from "./state-queries.js";

// Generation snapshot utilities (Nix-style generational state)
export {
  createGeneration,
  getGenerations,
  findGenerationByNumber,
  findLatestGenerationByImageId,
  findGenerationAtTime,
  getGenerationCount,
} from "./generations.js";

// Action helpers (shared utilities for deploy/rebuild actions)
export { inspectContainersWithRetry } from "./action-helpers.js";

// Dependency graph utilities
export {
  EffectiveServiceClosureError,
  buildServiceDependencyGraph,
  invertDependencyMap,
  resolveEffectiveServiceClosure,
  topologicalSort,
  computeExecutionPhases,
} from "./dependency-graph.js";
export type { EffectiveServiceClosureErrorCode } from "./dependency-graph.js";

// Deploy conflict-validation coordination
export {
  canonicalizeDeployEnvTool,
  composeExecutionOptions,
  inconclusiveValidation,
  revalidateDeployBinding,
  runDeployValidation,
  validationDependencyGraph,
  validationFailureFromError,
  validationScope,
} from "./deploy-validation.js";
export type { DeployValidationBinding, DeployValidationOutcome } from "./deploy-validation.js";

// Parallel executor utilities
export { executeParallelPhases, formatExecutionPlan } from "./parallel-executor.js";
export type { ParallelExecuteOptions } from "./parallel-executor.js";

// Staged rollout coordinator
export {
  planStagedBatches,
  executeStagedRollout,
  summarizeStagedRollout,
  formatStagedPlan,
  formatStagedEvent,
  formatStagedSummary,
  stagedExceedsLockStaleness,
} from "./staged-rollout.js";
export type {
  ExecuteStagedRolloutOptions,
  ExecuteStagedRolloutDeps,
  StagedPhaseOperation,
  StagedRunPhaseResult,
  StagedEventRender,
} from "./staged-rollout.js";

// Staged batch health gate
export { waitForBatchReady, createBatchObserver, isCompletedOneShot } from "./staged-gate.js";
export type {
  StagedServiceObservation,
  StagedBatchObservation,
  StagedBatchObserver,
  WaitForBatchReadyOptions,
  WaitForBatchReadyDeps,
} from "./staged-gate.js";

// Error classes and utilities
export * from "./errors.js";
export { registerRfappsErrorFormatters } from "./error-formatters.js";
export { findClosestMatch, findClosestMatches, computeSimilarity } from "./fuzzy-match.js";

// Formatter utilities
export { formatOutput } from "./formatters/index.js";
export type { FormatOptions } from "./formatters/index.js";

// MCP adapter exports
export { rfappsActionAdapters, RfappsMcpAdapterError } from "../mcp/adapters.js";
