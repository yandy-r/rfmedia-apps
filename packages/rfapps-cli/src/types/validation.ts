/**
 * Public contracts for deterministic pre-deploy conflict validation.
 *
 * These types contain only bounded resource projections. Raw Compose and Docker
 * payloads, timestamps, credentials, and executable remediation are deliberately
 * excluded from the versioned contract.
 */

/** Schema discriminator for service conflict validation results. */
export const CONFLICT_VALIDATION_SCHEMA_VERSION = "conflict-validation.v1" as const;

export type ConflictValidationStatus = "passed" | "blocked" | "inconclusive";
export type ConflictKind = "port" | "volume" | "network";
export type ConflictOrigin = "desired" | "runtime";
export type ConflictSeverity = "error" | "warning";

export type ConflictValidationCheckKind =
  | "compose"
  | "scope"
  | "authority"
  | "containers"
  | "volumes"
  | "networks"
  | "normalization"
  | "revalidation";

export type ConflictValidationCheckStatus = "passed" | "failed" | "unsupported";

/** Stable failure codes safe for machine branching and user-facing output. */
export type ConflictValidationFailureCode =
  | "COMPOSE_CONFIG_UNAVAILABLE"
  | "COMPOSE_CONFIG_INVALID"
  | "EFFECTIVE_SCOPE_UNAVAILABLE"
  | "DOCKER_AUTHORITY_UNAVAILABLE"
  | "CONTAINER_SNAPSHOT_UNAVAILABLE"
  | "VOLUME_SNAPSHOT_UNAVAILABLE"
  | "NETWORK_SNAPSHOT_UNAVAILABLE"
  | "EVIDENCE_INCOMPLETE"
  | "EVIDENCE_MALFORMED"
  | "EVIDENCE_LIMIT_EXCEEDED"
  | "UNSUPPORTED_RESOURCE_SHAPE"
  | "INVALID_CIDR"
  | "VALIDATION_INPUT_CHANGED"
  | "VALIDATION_AUTHORITY_CHANGED";

/** Sanitized reason for a failed or unsupported validation check. */
export interface ConflictValidationFailure {
  code: ConflictValidationFailureCode;
  check: ConflictValidationCheckKind;
  message: string;
}

interface ConflictValidationCheckBase {
  id: ConflictValidationCheckKind;
  required: boolean;
  /** Number of bounded resource projections successfully evaluated by this check. */
  resources: number;
}

export interface PassedConflictValidationCheck extends ConflictValidationCheckBase {
  status: "passed";
}

export interface UnavailableConflictValidationCheck extends ConflictValidationCheckBase {
  status: "failed" | "unsupported";
  failure: ConflictValidationFailure;
}

/** One deterministic evidence or comparison lane in the validation run. */
export type ConflictValidationCheck =
  | PassedConflictValidationCheck
  | UnavailableConflictValidationCheck;

export type PortAddressFamily = "ipv4" | "ipv6";
export type PortProtocol = "tcp" | "udp" | "sctp";

/** Inclusive numeric interval. Evaluators retain intervals instead of expanding ranges. */
export interface PortInterval {
  start: number;
  end: number;
}

/**
 * Desired published-port allocation semantics.
 *
 * A choice range offers one port from an interval, while a fixed interval claims
 * every corresponding published port. Dynamic allocation makes no fixed claim.
 */
export type DesiredPortAllocation =
  | { mode: "fixed"; published: PortInterval }
  | { mode: "choice"; published: PortInterval }
  | { mode: "dynamic" };

export interface DesiredPortClaim {
  kind: "port";
  origin: "desired";
  project: string;
  service: string;
  family: PortAddressFamily;
  hostIp: string;
  protocol: PortProtocol;
  allocation: DesiredPortAllocation;
}

export interface RuntimePortClaim {
  kind: "port";
  origin: "runtime";
  containerId: string;
  containerName: string;
  project?: string;
  service?: string;
  family: PortAddressFamily;
  hostIp: string;
  protocol: PortProtocol;
  published: PortInterval;
}

export interface DesiredPortConflictParty {
  kind: "port";
  origin: "desired";
  ownerType: "service";
  name: string;
  project: string;
  service: string;
  /** The party's complete normalized claim, including allocation semantics. */
  claim: DesiredPortClaim;
}

export interface RuntimePortConflictParty {
  kind: "port";
  origin: "runtime";
  ownerType: "container";
  name: string;
  containerId: string;
  project?: string;
  service?: string;
  /** The party's complete observed bind claim. */
  claim: RuntimePortClaim;
}

export type PortConflictParty = DesiredPortConflictParty | RuntimePortConflictParty;

export type ConflictMountType = "bind" | "volume" | "tmpfs";

/**
 * Narrow mount projection used for equality and duplicate-target checks.
 *
 * Bind source identities are ephemeral evaluator input and must not be copied to
 * findings or normal output.
 */
export interface ConflictMountProjection {
  type: ConflictMountType;
  source?: string;
  target: string;
  readOnly: boolean;
}

export interface DesiredVolumeProjection {
  key: string;
  name: string;
  external: boolean;
  driver: string;
  driverOptions: Readonly<Record<string, string>>;
}

export interface RuntimeVolumeProjection {
  name: string;
  driver: string;
  driverOptions: Readonly<Record<string, string>>;
}

export type DesiredVolumeConflictParty =
  | {
      kind: "volume";
      origin: "desired";
      ownerType: "service";
      name: string;
      project: string;
      service: string;
    }
  | {
      kind: "volume";
      origin: "desired";
      ownerType: "volume";
      name: string;
      project: string;
      volume: string;
    };

export interface RuntimeVolumeConflictParty {
  kind: "volume";
  origin: "runtime";
  ownerType: "volume";
  name: string;
  volume: string;
}

export type VolumeConflictParty = DesiredVolumeConflictParty | RuntimeVolumeConflictParty;

export interface DesiredNetworkProjection {
  key: string;
  name: string;
  external: boolean;
  driver: string;
  subnets: readonly string[];
}

export interface RuntimeNetworkProjection {
  id: string;
  name: string;
  driver: string;
  subnets: readonly string[];
}

export interface DesiredNetworkConflictParty {
  kind: "network";
  origin: "desired";
  ownerType: "network";
  name: string;
  project: string;
  network: string;
}

export interface RuntimeNetworkConflictParty {
  kind: "network";
  origin: "runtime";
  ownerType: "network";
  name: string;
  networkId: string;
  network: string;
}

export type NetworkConflictParty = DesiredNetworkConflictParty | RuntimeNetworkConflictParty;
export type ConflictParty = PortConflictParty | VolumeConflictParty | NetworkConflictParty;

export interface PortConflictResource {
  kind: "port";
  /** Canonical intersection shared by the parties' complete claims. */
  family: PortAddressFamily;
  hostIp: string;
  protocol: PortProtocol;
  published: PortInterval;
}

export type VolumeConflictResource =
  | {
      kind: "volume";
      incompatibility: "driver" | "driver-options" | "missing-external" | "runtime-definition";
      name: string;
    }
  | {
      kind: "volume";
      incompatibility: "duplicate-target";
      service: string;
      target: string;
    };

export interface NetworkConflictResource {
  kind: "network";
  family: PortAddressFamily;
  subnet: string;
  overlaps: string;
}

export type ConflictResource =
  | PortConflictResource
  | VolumeConflictResource
  | NetworkConflictResource;

/** Stable finding codes for objective conflicts and non-blocking observations. */
export type ServiceConflictCode =
  | "PORT_BINDING_CONFLICT"
  | "PORT_RANGE_EXHAUSTED"
  | "DYNAMIC_PORT_ALLOCATION"
  | "VOLUME_DEFINITION_CONFLICT"
  | "VOLUME_RUNTIME_CONFLICT"
  | "VOLUME_TARGET_CONFLICT"
  | "EXTERNAL_VOLUME_MISSING"
  | "NETWORK_SUBNET_CONFLICT";

interface ConflictResolutionBase {
  id: string;
  message: string;
}

export interface ChangeComposePortResolution extends ConflictResolutionBase {
  action: "change-compose-port";
  service: string;
  suggestedPort?: number;
}

export interface InspectRuntimeOwnerResolution extends ConflictResolutionBase {
  action: "inspect-runtime-owner";
  resourceType: "container" | "volume" | "network";
  name: string;
}

export interface StopOrReconfigureContainerResolution extends ConflictResolutionBase {
  action: "stop-or-reconfigure-container";
  container: string;
}

export interface AlignVolumeDefinitionResolution extends ConflictResolutionBase {
  action: "align-volume-definition";
  volume: string;
}

export interface ChangeVolumeMountResolution extends ConflictResolutionBase {
  action: "change-volume-mount";
  service: string;
  target: string;
}

export interface CreateExternalVolumeResolution extends ConflictResolutionBase {
  action: "create-external-volume";
  volume: string;
}

export interface ChangeNetworkSubnetResolution extends ConflictResolutionBase {
  action: "change-network-subnet";
  network: string;
  suggestedSubnet?: string;
}

export interface RemoveOrReconfigureNetworkResolution extends ConflictResolutionBase {
  action: "remove-or-reconfigure-network";
  network: string;
}

/**
 * Inert operator guidance. These records never contain commands, callbacks, or
 * authorization to mutate a resource.
 */
export type ConflictResolution =
  | ChangeComposePortResolution
  | InspectRuntimeOwnerResolution
  | StopOrReconfigureContainerResolution
  | AlignVolumeDefinitionResolution
  | ChangeVolumeMountResolution
  | CreateExternalVolumeResolution
  | ChangeNetworkSubnetResolution
  | RemoveOrReconfigureNetworkResolution;

interface ServiceConflictBase {
  id: string;
  code: ServiceConflictCode;
  severity: ConflictSeverity;
  origin: ConflictOrigin;
  message: string;
  resolutions: readonly ConflictResolution[];
}

export interface PortServiceConflict extends ServiceConflictBase {
  kind: "port";
  resource: PortConflictResource;
  parties: readonly PortConflictParty[];
}

export interface VolumeServiceConflict extends ServiceConflictBase {
  kind: "volume";
  resource: VolumeConflictResource;
  parties: readonly VolumeConflictParty[];
}

export interface NetworkServiceConflict extends ServiceConflictBase {
  kind: "network";
  resource: NetworkConflictResource;
  parties: readonly NetworkConflictParty[];
}

/** A blocking or warning finding with kind-matched resource and party data. */
export type ServiceConflict = PortServiceConflict | VolumeServiceConflict | NetworkServiceConflict;

export interface ConflictValidationSummary {
  total: number;
  errors: number;
  warnings: number;
  ports: number;
  volumes: number;
  networks: number;
}

export type ConflictLimitationCode =
  | "NON_DOCKER_PORT_OWNERS_NOT_CHECKED"
  | "HOST_NETWORK_PORTS_NOT_CHECKED"
  | "DYNAMIC_PORT_ALLOCATION_NOT_PREDICTED"
  | "AUTO_ASSIGNED_NETWORK_SUBNETS_NOT_CHECKED"
  | "HOST_NETWORK_ROUTES_NOT_CHECKED"
  | "APPLICATION_VOLUME_COMPATIBILITY_NOT_CHECKED"
  | "THIRD_PARTY_DRIVER_SEMANTICS_NOT_CHECKED"
  | "POINT_IN_TIME_SNAPSHOT";

export interface ConflictLimitation {
  code: ConflictLimitationCode;
  kind?: ConflictKind;
  message: string;
}

export interface ConflictValidationScope {
  project: string;
  services: readonly string[];
  profiles: readonly string[];
}

export interface DesiredServiceProjection {
  project: string;
  service: string;
  ports: readonly DesiredPortClaim[];
  mounts: readonly ConflictMountProjection[];
  networks: readonly string[];
  dependencies: readonly string[];
}

export interface ConflictDesiredState {
  project: string;
  services: readonly DesiredServiceProjection[];
  volumes: readonly DesiredVolumeProjection[];
  networks: readonly DesiredNetworkProjection[];
}

export interface RuntimeContainerProjection {
  id: string;
  name: string;
  project?: string;
  service?: string;
  ports: readonly RuntimePortClaim[];
  mounts: readonly ConflictMountProjection[];
}

/**
 * Bounded, narrow Docker evidence captured under one authority.
 *
 * Fingerprints are one-way identities used to bind validation to deployment;
 * endpoints, environment values, and raw inspect objects are never retained.
 */
export interface ConflictRuntimeSnapshot {
  containers: readonly RuntimeContainerProjection[];
  networks: readonly RuntimeNetworkProjection[];
  volumes: readonly RuntimeVolumeProjection[];
  /**
   * Whether the volume snapshot is authoritative for runtime-dependent checks.
   *
   * Omitted means available for backwards compatibility with direct evaluator
   * callers. Coordinators must set this to false when collection fails.
   */
  volumeEvidenceAvailable?: boolean;
  authorityFingerprint: string;
  composeFingerprint: string;
}

export interface ConflictValidationInput {
  scope: ConflictValidationScope;
  desired: ConflictDesiredState;
  runtime: ConflictRuntimeSnapshot;
}

interface ConflictValidationResultBase {
  schemaVersion: typeof CONFLICT_VALIDATION_SCHEMA_VERSION;
  scope: ConflictValidationScope;
  checks: readonly ConflictValidationCheck[];
  summary: ConflictValidationSummary;
  conflicts: readonly ServiceConflict[];
  warnings: readonly ServiceConflict[];
  limitations: readonly ConflictLimitation[];
}

export interface PassedConflictValidationResult extends ConflictValidationResultBase {
  status: "passed";
  error?: never;
}

export interface BlockedConflictValidationResult extends ConflictValidationResultBase {
  status: "blocked";
  error?: never;
}

export interface InconclusiveConflictValidationResult extends ConflictValidationResultBase {
  status: "inconclusive";
  error: ConflictValidationFailure;
}

/** Complete deterministic result returned by one opt-in validation run. */
export type ConflictValidationResult =
  | PassedConflictValidationResult
  | BlockedConflictValidationResult
  | InconclusiveConflictValidationResult;
