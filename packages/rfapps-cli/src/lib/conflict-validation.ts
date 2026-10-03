/**
 * Pure service-conflict evaluation and human-readable projection.
 *
 * Inputs are narrow, bounded projections produced by the Docker adapter. This
 * module performs no I/O and never mutates caller-owned data.
 */

import {
  CONFLICT_VALIDATION_SCHEMA_VERSION,
  type ConflictDesiredState,
  type ConflictLimitation,
  type ConflictLimitationCode,
  type ConflictParty,
  type ConflictRuntimeSnapshot,
  type ConflictValidationCheck,
  type ConflictValidationFailure,
  type ConflictValidationInput,
  type ConflictValidationResult,
  type ConflictValidationScope,
  type ServiceConflict,
} from "../types/validation.js";
import {
  compareCodePoints,
  type EvaluationBudget,
  normalizeDriver,
  sanitizeDisplay,
  sortedUnique,
} from "./conflict-evaluator-shared.js";
import { evaluateNetworks } from "./conflict-network-evaluator.js";
import { evaluatePorts } from "./conflict-port-evaluator.js";
import { evaluateVolumes } from "./conflict-volume-evaluator.js";

const MAX_PROJECTED_CLAIMS = 4_096;

const KIND_RANK = {
  port: 0,
  volume: 1,
  network: 2,
} as const satisfies Record<ServiceConflict["kind"], number>;

const CHECK_RANK = {
  compose: 0,
  scope: 1,
  authority: 2,
  containers: 3,
  volumes: 4,
  networks: 5,
  normalization: 6,
  revalidation: 7,
} as const satisfies Record<ConflictValidationCheck["id"], number>;

const BASE_LIMITATIONS: readonly ConflictLimitation[] = [
  {
    code: "NON_DOCKER_PORT_OWNERS_NOT_CHECKED",
    kind: "port",
    message: "Non-Docker host listeners are outside this validation.",
  },
  {
    code: "HOST_NETWORK_PORTS_NOT_CHECKED",
    kind: "port",
    message: "Application listeners using host networking are outside this validation.",
  },
  {
    code: "HOST_NETWORK_ROUTES_NOT_CHECKED",
    kind: "network",
    message: "Host LAN, VPN, and routing tables are outside this validation.",
  },
  {
    code: "APPLICATION_VOLUME_COMPATIBILITY_NOT_CHECKED",
    kind: "volume",
    message: "Application-level compatibility for shared storage is not inferred.",
  },
  {
    code: "POINT_IN_TIME_SNAPSHOT",
    message:
      "Validation is point-in-time evidence, not a reservation; Docker remains the final allocator.",
  },
];

function projectedClaimCount(input: Readonly<ConflictValidationInput>): number {
  let total = input.scope.services.length + input.scope.profiles.length;
  for (const service of input.desired.services) {
    total +=
      1 +
      service.ports.length +
      service.mounts.length +
      service.networks.length +
      service.dependencies.length;
  }
  for (const volume of input.desired.volumes) {
    total += 1 + Object.keys(volume.driverOptions).length;
  }
  for (const network of input.desired.networks) {
    total += 1 + network.subnets.length;
  }
  for (const container of input.runtime.containers) {
    total += 1 + container.ports.length + container.mounts.length;
  }
  if (input.runtime.volumeEvidenceAvailable !== false) {
    for (const volume of input.runtime.volumes) {
      total += 1 + Object.keys(volume.driverOptions).length;
    }
  }
  for (const network of input.runtime.networks) {
    total += 1 + network.subnets.length;
  }
  return total;
}

function sanitizeScope(scope: ConflictValidationScope): ConflictValidationScope {
  return {
    project: sanitizeDisplay(scope.project),
    services: sortedUnique(scope.services),
    profiles: sortedUnique(scope.profiles),
  };
}

function conflictKey(conflict: ServiceConflict): string {
  return `${KIND_RANK[conflict.kind]}|${conflict.code}|${conflict.id}`;
}

function sortFindings(findings: readonly ServiceConflict[]): ServiceConflict[] {
  return findings
    .slice()
    .sort((left, right) => compareCodePoints(conflictKey(left), conflictKey(right)));
}

function sortChecks(checks: readonly ConflictValidationCheck[]): ConflictValidationCheck[] {
  return checks.slice().sort((left, right) => CHECK_RANK[left.id] - CHECK_RANK[right.id]);
}

function limitation(
  code: ConflictLimitationCode,
  message: string,
  kind?: ConflictLimitation["kind"],
): ConflictLimitation {
  return {
    code,
    ...(kind === undefined ? {} : { kind }),
    message,
  };
}

function buildLimitations(
  dynamicPorts: boolean,
  autoAssignedNetworks: boolean,
  desired: ConflictDesiredState,
  runtime: ConflictRuntimeSnapshot,
): ConflictLimitation[] {
  const limitations = BASE_LIMITATIONS.map((entry) => ({ ...entry }));
  if (dynamicPorts) {
    limitations.push(
      limitation(
        "DYNAMIC_PORT_ALLOCATION_NOT_PREDICTED",
        "Daemon-assigned published ports do not make a fixed preflight claim.",
        "port",
      ),
    );
  }
  if (autoAssignedNetworks) {
    limitations.push(
      limitation(
        "AUTO_ASSIGNED_NETWORK_SUBNETS_NOT_CHECKED",
        "Auto-assigned Docker network subnets cannot be predicted by this validation.",
        "network",
      ),
    );
  }
  const hasThirdPartyDriver =
    desired.volumes.some((volume) => normalizeDriver(volume.driver) !== "local") ||
    runtime.volumes.some((volume) => normalizeDriver(volume.driver) !== "local") ||
    desired.networks.some(
      (network) =>
        network.driver.trim() !== "" &&
        !["bridge", "overlay", "macvlan", "ipvlan"].includes(network.driver.trim().toLowerCase()),
    ) ||
    runtime.networks.some(
      (network) =>
        network.driver.trim() !== "" &&
        !["bridge", "overlay", "macvlan", "ipvlan"].includes(network.driver.trim().toLowerCase()),
    );
  if (hasThirdPartyDriver) {
    limitations.push(
      limitation(
        "THIRD_PARTY_DRIVER_SEMANTICS_NOT_CHECKED",
        "Third-party volume or network driver semantics are not inferred.",
      ),
    );
  }
  return limitations.slice().sort((left, right) => compareCodePoints(left.code, right.code));
}

function buildSummary(
  conflicts: readonly ServiceConflict[],
  warnings: readonly ServiceConflict[],
): ConflictValidationResult["summary"] {
  const findings = [...conflicts, ...warnings];
  return {
    total: findings.length,
    errors: conflicts.length,
    warnings: warnings.length,
    ports: findings.filter((finding) => finding.kind === "port").length,
    volumes: findings.filter((finding) => finding.kind === "volume").length,
    networks: findings.filter((finding) => finding.kind === "network").length,
  };
}

function projectedClaimLimitResult(
  input: Readonly<ConflictValidationInput>,
  scope: ConflictValidationScope,
): ConflictValidationResult {
  const failure: ConflictValidationFailure = {
    code: "EVIDENCE_LIMIT_EXCEEDED",
    check: "normalization",
    message: "Projected resource claims exceeded the deterministic validation limit.",
  };
  return {
    schemaVersion: CONFLICT_VALIDATION_SCHEMA_VERSION,
    status: "inconclusive",
    scope,
    checks: sortChecks([
      {
        id: "compose",
        status: "passed",
        required: true,
        resources:
          input.desired.services.length +
          input.desired.volumes.length +
          input.desired.networks.length,
      },
      {
        id: "scope",
        status: "passed",
        required: true,
        resources: scope.services.length,
      },
      {
        id: "authority",
        status: "passed",
        required: true,
        resources: 2,
      },
      {
        id: "containers",
        status: "passed",
        required: true,
        resources: input.runtime.containers.length,
      },
      {
        id: "volumes",
        status: "passed",
        required: true,
        resources:
          input.desired.volumes.length +
          (input.runtime.volumeEvidenceAvailable === false ? 0 : input.runtime.volumes.length),
      },
      {
        id: "networks",
        status: "passed",
        required: true,
        resources: input.desired.networks.length + input.runtime.networks.length,
      },
      {
        id: "normalization",
        status: "failed",
        required: true,
        resources: 0,
        failure,
      },
    ]),
    summary: buildSummary([], []),
    conflicts: [],
    warnings: [],
    limitations: BASE_LIMITATIONS.map((entry) => ({ ...entry })).sort((left, right) =>
      compareCodePoints(left.code, right.code),
    ),
    error: failure,
  };
}

/**
 * Evaluate desired and observed Docker resource projections.
 *
 * Any normalization failure makes the aggregate result inconclusive, even when
 * independent definite conflicts were also found.
 */
export function evaluateConflictValidation(
  input: Readonly<ConflictValidationInput>,
): ConflictValidationResult {
  const scope = sanitizeScope(input.scope);
  if (projectedClaimCount(input) > MAX_PROJECTED_CLAIMS) {
    return projectedClaimLimitResult(input, scope);
  }
  const budget: EvaluationBudget = {
    comparisonWork: 0,
    findings: 0,
  };
  const requestedServices = new Set(input.scope.services);
  const services = input.desired.services
    .filter((service) => requestedServices.has(service.service))
    .slice()
    .sort((left, right) => compareCodePoints(left.service, right.service));

  const ports = evaluatePorts(services, input.runtime.containers, input.scope, budget);
  const volumeFindings =
    budget.issue === undefined
      ? evaluateVolumes(
          input.desired.project,
          services,
          input.desired.volumes,
          input.runtime.volumes,
          input.runtime.volumeEvidenceAvailable !== false,
          budget,
        )
      : [];
  const networks =
    budget.issue === undefined
      ? evaluateNetworks(
          input.desired.project,
          services,
          input.desired.networks,
          input.runtime.networks,
          budget,
        )
      : {
          findings: [],
          issues: [],
          normalizedResources: 0,
          autoAssigned: false,
        };
  const issues = [
    ...(budget.issue === undefined ? [] : [budget.issue]),
    ...ports.issues,
    ...networks.issues,
  ].sort((left, right) => compareCodePoints(left.key, right.key));
  const conflicts = sortFindings([...ports.findings, ...volumeFindings, ...networks.findings]);
  const warnings: ServiceConflict[] = [];
  const checks = sortChecks([
    {
      id: "compose",
      status: "passed",
      required: true,
      resources: services.length + input.desired.volumes.length + input.desired.networks.length,
    },
    {
      id: "scope",
      status: "passed",
      required: true,
      resources: scope.services.length,
    },
    {
      id: "authority",
      status: "passed",
      required: true,
      resources: 2,
    },
    {
      id: "containers",
      status: "passed",
      required: true,
      resources: input.runtime.containers.length,
    },
    {
      id: "volumes",
      status: "passed",
      required: true,
      resources:
        input.desired.volumes.length +
        (input.runtime.volumeEvidenceAvailable === false ? 0 : input.runtime.volumes.length),
    },
    {
      id: "networks",
      status: "passed",
      required: true,
      resources: input.desired.networks.length + input.runtime.networks.length,
    },
    ...(issues.length === 0
      ? [
          {
            id: "normalization",
            status: "passed",
            required: true,
            resources: ports.normalizedResources + networks.normalizedResources,
          } satisfies ConflictValidationCheck,
        ]
      : [
          {
            id: "normalization",
            status: "failed",
            required: true,
            resources: ports.normalizedResources + networks.normalizedResources,
            failure: issues[0]?.failure ?? {
              code: "EVIDENCE_MALFORMED",
              check: "normalization",
              message: "Resource normalization failed.",
            },
          } satisfies ConflictValidationCheck,
        ]),
  ]);
  const base = {
    schemaVersion: CONFLICT_VALIDATION_SCHEMA_VERSION,
    scope,
    checks,
    summary: buildSummary(conflicts, warnings),
    conflicts,
    warnings,
    limitations: buildLimitations(
      ports.dynamic,
      networks.autoAssigned,
      input.desired,
      input.runtime,
    ),
  };

  if (issues.length > 0) {
    return {
      ...base,
      status: "inconclusive",
      error: issues[0]?.failure ?? {
        code: "EVIDENCE_MALFORMED",
        check: "normalization",
        message: "Resource normalization failed.",
      },
    };
  }
  if (conflicts.length > 0) {
    return { ...base, status: "blocked" };
  }
  return { ...base, status: "passed" };
}

function partyDescription(party: ConflictParty): string {
  switch (party.kind) {
    case "port":
      return party.origin === "desired"
        ? `desired service ${sanitizeDisplay(party.project)}/${sanitizeDisplay(party.service)}`
        : `runtime container ${sanitizeDisplay(party.name)}`;
    case "volume":
      return party.ownerType === "service"
        ? `desired service ${sanitizeDisplay(party.project)}/${sanitizeDisplay(party.service)}`
        : `${party.origin} volume ${sanitizeDisplay(party.name)}`;
    case "network":
      return `${party.origin} network ${sanitizeDisplay(party.name)}`;
  }
}

/** Produce stable, line-oriented human output from the machine result. */
export function formatConflictValidationText(result: ConflictValidationResult): string[] {
  const lines = [
    `Conflict validation: ${result.status.toUpperCase()}`,
    `Scope: ${result.scope.services.map((service) => sanitizeDisplay(service)).join(", ") || "no services"} (project ${sanitizeDisplay(result.scope.project)}; profiles ${result.scope.profiles.map((profile) => sanitizeDisplay(profile)).join(", ") || "none"})`,
    `Findings: ${result.summary.total} total, ${result.summary.errors} blocking, ${result.summary.warnings} warnings`,
  ];

  if (result.status === "inconclusive") {
    lines.push(`Evidence failure: ${sanitizeDisplay(result.error.message)} (${result.error.code})`);
  }

  if (result.conflicts.length > 0) {
    lines.push("", "Blocking conflicts:");
    for (const conflict of result.conflicts) {
      lines.push(
        `  - [${conflict.kind}] ${sanitizeDisplay(conflict.message)} (${sanitizeDisplay(conflict.id)})`,
        `    Owners: ${conflict.parties.map(partyDescription).join("; ")}`,
      );
      for (const resolution of conflict.resolutions) {
        lines.push(`    Manual resolution: ${sanitizeDisplay(resolution.message)}`);
      }
    }
  } else if (result.status === "passed") {
    lines.push("", "No blocking Docker resource conflicts found.");
  }

  lines.push("", "Limitations:");
  for (const entry of result.limitations) {
    lines.push(`  - ${sanitizeDisplay(entry.message)} (${entry.code})`);
  }
  return lines;
}
