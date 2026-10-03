import type {
  ConflictMountProjection,
  ConflictResolution,
  DesiredServiceProjection,
  DesiredVolumeProjection,
  RuntimeVolumeProjection,
  ServiceConflictCode,
  VolumeConflictParty,
  VolumeServiceConflict,
} from "../types/validation.js";
import {
  appendFinding,
  compareCodePoints,
  consumeComparisonWork,
  type EvaluationBudget,
  findingId,
  normalizeDriver,
  partyKey,
  resolutionId,
  sanitizeDisplay,
  sortParties,
  sortResolutions,
} from "./conflict-evaluator-shared.js";

function optionsKey(options: Readonly<Record<string, string>>): string {
  return Object.entries(options)
    .map(([key, value]) => [key.trim(), value.trim()] as const)
    .sort(([left], [right]) => compareCodePoints(left, right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\u001f");
}

function volumeDefinitionKey(volume: DesiredVolumeProjection | RuntimeVolumeProjection): string {
  return `${normalizeDriver(volume.driver)}|${optionsKey(volume.driverOptions)}`;
}

function desiredVolumeParty(project: string, volume: DesiredVolumeProjection): VolumeConflictParty {
  const name = sanitizeDisplay(volume.name);
  return {
    kind: "volume",
    origin: "desired",
    ownerType: "volume",
    name,
    project: sanitizeDisplay(project),
    volume: name,
  };
}

function runtimeVolumeParty(volume: RuntimeVolumeProjection): VolumeConflictParty {
  const name = sanitizeDisplay(volume.name);
  return {
    kind: "volume",
    origin: "runtime",
    ownerType: "volume",
    name,
    volume: name,
  };
}

function serviceVolumeParty(project: string, service: string): VolumeConflictParty {
  return {
    kind: "volume",
    origin: "desired",
    ownerType: "service",
    name: sanitizeDisplay(service),
    project: sanitizeDisplay(project),
    service: sanitizeDisplay(service),
  };
}

function buildVolumeConflict(
  code: Extract<
    ServiceConflictCode,
    | "VOLUME_DEFINITION_CONFLICT"
    | "VOLUME_RUNTIME_CONFLICT"
    | "VOLUME_TARGET_CONFLICT"
    | "EXTERNAL_VOLUME_MISSING"
  >,
  resource: VolumeServiceConflict["resource"],
  parties: readonly VolumeConflictParty[],
  origin: VolumeServiceConflict["origin"],
  message: string,
  resolutions: readonly ConflictResolution[],
): VolumeServiceConflict {
  const sortedParties = sortParties(parties);
  const key = [
    code,
    resource.incompatibility,
    "name" in resource ? resource.name : resource.service,
    "target" in resource ? resource.target : "",
    ...sortedParties.map(partyKey),
  ].join("|");
  return {
    id: findingId("volume", code, key),
    code,
    kind: "volume",
    severity: "error",
    origin,
    message,
    resource,
    parties: sortedParties,
    resolutions: sortResolutions(resolutions),
  };
}

function alignVolumeResolution(volume: string): ConflictResolution {
  return {
    id: resolutionId("align-volume-definition", volume),
    action: "align-volume-definition",
    volume,
    message: `Manually align the driver and options for volume ${volume}.`,
  };
}

export function evaluateVolumes(
  project: string,
  services: readonly DesiredServiceProjection[],
  desiredVolumes: readonly DesiredVolumeProjection[],
  runtimeVolumes: readonly RuntimeVolumeProjection[],
  runtimeEvidenceAvailable: boolean,
  budget: EvaluationBudget,
): VolumeServiceConflict[] {
  const findings: VolumeServiceConflict[] = [];
  const usedSources = new Set(
    services.flatMap((service) =>
      service.mounts.flatMap((mount) =>
        mount.type === "volume" && mount.source !== undefined ? [mount.source] : [],
      ),
    ),
  );
  const relevantDesired = desiredVolumes
    .filter((volume) => usedSources.has(volume.key) || usedSources.has(volume.name))
    .slice()
    .sort((left, right) =>
      compareCodePoints(`${left.name}|${left.key}`, `${right.name}|${right.key}`),
    );
  const runtimeByName = new Map(runtimeVolumes.map((volume) => [volume.name, volume]));

  desiredPairs: for (let leftIndex = 0; leftIndex < relevantDesired.length; leftIndex += 1) {
    const left = relevantDesired[leftIndex];
    if (left === undefined) {
      continue;
    }
    for (let rightIndex = leftIndex + 1; rightIndex < relevantDesired.length; rightIndex += 1) {
      if (!consumeComparisonWork(budget)) {
        break desiredPairs;
      }
      const right = relevantDesired[rightIndex];
      if (
        right === undefined ||
        left.name !== right.name ||
        left.external ||
        right.external ||
        volumeDefinitionKey(left) === volumeDefinitionKey(right)
      ) {
        continue;
      }
      const name = sanitizeDisplay(left.name);
      const incompatibility =
        normalizeDriver(left.driver) !== normalizeDriver(right.driver)
          ? "driver"
          : "driver-options";
      if (
        !appendFinding(
          findings,
          buildVolumeConflict(
            "VOLUME_DEFINITION_CONFLICT",
            { kind: "volume", incompatibility, name },
            [desiredVolumeParty(project, left), desiredVolumeParty(project, right)],
            "desired",
            `Desired volume definitions for ${name} disagree.`,
            [alignVolumeResolution(name)],
          ),
          budget,
        )
      ) {
        break desiredPairs;
      }
    }
  }

  if (budget.issue !== undefined) {
    return findings;
  }

  if (runtimeEvidenceAvailable) {
    for (const desired of relevantDesired) {
      if (!consumeComparisonWork(budget)) {
        break;
      }
      const name = sanitizeDisplay(desired.name);
      const runtime = runtimeByName.get(desired.name);
      if (desired.external) {
        if (runtime === undefined) {
          if (
            !appendFinding(
              findings,
              buildVolumeConflict(
                "EXTERNAL_VOLUME_MISSING",
                { kind: "volume", incompatibility: "missing-external", name },
                [desiredVolumeParty(project, desired)],
                "runtime",
                `Required external volume ${name} does not exist.`,
                [
                  {
                    id: resolutionId("create-external-volume", name),
                    action: "create-external-volume",
                    volume: name,
                    message: `Manually create or correct the external volume identity ${name}.`,
                  },
                ],
              ),
              budget,
            )
          ) {
            break;
          }
        }
        continue;
      }
      if (runtime === undefined || volumeDefinitionKey(desired) === volumeDefinitionKey(runtime)) {
        continue;
      }
      if (
        !appendFinding(
          findings,
          buildVolumeConflict(
            "VOLUME_RUNTIME_CONFLICT",
            { kind: "volume", incompatibility: "runtime-definition", name },
            [desiredVolumeParty(project, desired), runtimeVolumeParty(runtime)],
            "runtime",
            `Existing Docker volume ${name} has a different driver or option definition.`,
            [
              alignVolumeResolution(name),
              {
                id: resolutionId("inspect-runtime-owner", `volume:${name}`),
                action: "inspect-runtime-owner",
                resourceType: "volume",
                name,
                message: `Inspect Docker volume ${name} before changing either definition.`,
              },
            ],
          ),
          budget,
        )
      ) {
        break;
      }
    }
  }

  if (budget.issue !== undefined) {
    return findings;
  }

  for (const service of services) {
    const mountsByTarget = new Map<string, ConflictMountProjection[]>();
    for (const mount of service.mounts) {
      const mounts = mountsByTarget.get(mount.target) ?? [];
      mounts.push(mount);
      mountsByTarget.set(mount.target, mounts);
    }
    for (const [rawTarget, mounts] of mountsByTarget) {
      if (!consumeComparisonWork(budget)) {
        return findings;
      }
      const identities = new Set(mounts.map((mount) => `${mount.type}\u001f${mount.source ?? ""}`));
      if (identities.size <= 1) {
        continue;
      }
      const serviceName = sanitizeDisplay(service.service);
      const target = sanitizeDisplay(rawTarget);
      if (
        !appendFinding(
          findings,
          buildVolumeConflict(
            "VOLUME_TARGET_CONFLICT",
            {
              kind: "volume",
              incompatibility: "duplicate-target",
              service: serviceName,
              target,
            },
            [serviceVolumeParty(project, serviceName)],
            "desired",
            `Service ${serviceName} maps different mount identities to target ${target}.`,
            [
              {
                id: resolutionId("change-volume-mount", `${serviceName}:${target}`),
                action: "change-volume-mount",
                service: serviceName,
                target,
                message: `Manually keep one intended mount identity for ${serviceName} at ${target}.`,
              },
            ],
          ),
          budget,
        )
      ) {
        return findings;
      }
    }
  }

  return findings;
}
