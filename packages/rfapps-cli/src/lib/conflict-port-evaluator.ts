import ipaddr from "ipaddr.js";
import type {
  ConflictParty,
  ConflictResolution,
  ConflictValidationScope,
  DesiredPortAllocation,
  DesiredPortClaim,
  DesiredServiceProjection,
  PortAddressFamily,
  PortConflictParty,
  PortInterval,
  PortServiceConflict,
  RuntimeContainerProjection,
  RuntimePortClaim,
} from "../types/validation.js";
import {
  appendFinding,
  type EvaluationBudget,
  type NormalizationIssue,
  compareCodePoints,
  consumeComparisonWork,
  findingId,
  groupBy,
  resolutionId,
  sanitizeDisplay,
} from "./conflict-evaluator-shared.js";

const MAX_CHOICE_ASSIGNMENT_WORK = 10_000;

interface NormalizedDesiredPort {
  readonly claim: DesiredPortClaim;
  readonly ownerKey: string;
}

interface NormalizedRuntimePort {
  readonly claim: RuntimePortClaim;
  readonly ownerKey: string;
}

interface ChoicePort extends NormalizedDesiredPort {
  readonly claim: DesiredPortClaim & {
    readonly allocation: { readonly mode: "choice"; readonly published: PortInterval };
  };
}

interface OccupiedPort {
  readonly claim: DesiredPortClaim | RuntimePortClaim;
  readonly published: PortInterval;
}

type ChoiceAssignmentResult = "exists" | "exhausted" | "inconclusive";

function intervalsOverlap(left: PortInterval, right: PortInterval): boolean {
  return left.start <= right.end && right.start <= left.end;
}

function intersectIntervals(left: PortInterval, right: PortInterval): PortInterval {
  return {
    start: Math.max(left.start, right.start),
    end: Math.min(left.end, right.end),
  };
}

function validPortInterval(interval: PortInterval): boolean {
  return (
    Number.isInteger(interval.start) &&
    Number.isInteger(interval.end) &&
    interval.start >= 1 &&
    interval.end <= 65_535 &&
    interval.start <= interval.end
  );
}

function wildcardAddress(family: PortAddressFamily): string {
  return family === "ipv4" ? "0.0.0.0" : "::";
}

function normalizeHostIp(hostIp: string, family: PortAddressFamily): string | undefined {
  const candidate = hostIp.trim() === "" ? wildcardAddress(family) : hostIp.trim();
  try {
    const parsed = ipaddr.parse(candidate);
    return parsed.kind() === family ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function intersectHostIps(
  left: Pick<DesiredPortClaim | RuntimePortClaim, "family" | "hostIp">,
  right: Pick<DesiredPortClaim | RuntimePortClaim, "family" | "hostIp">,
): string | undefined {
  if (left.family !== right.family) {
    return undefined;
  }
  if (left.hostIp === right.hostIp) {
    return left.hostIp;
  }
  const wildcard = wildcardAddress(left.family);
  if (left.hostIp === wildcard) {
    return right.hostIp;
  }
  if (right.hostIp === wildcard) {
    return left.hostIp;
  }
  return undefined;
}

function normalizeDesiredPort(
  service: DesiredServiceProjection,
  claim: DesiredPortClaim,
): NormalizedDesiredPort | NormalizationIssue {
  const interval =
    claim.allocation.mode === "dynamic" ? undefined : { ...claim.allocation.published };
  const hostIp = normalizeHostIp(claim.hostIp, claim.family);
  if (hostIp === undefined || (interval !== undefined && !validPortInterval(interval))) {
    return {
      key: `desired:${service.project}:${service.service}:${claim.family}:${claim.protocol}`,
      failure: {
        code: "UNSUPPORTED_RESOURCE_SHAPE",
        check: "normalization",
        message: "A desired published-port claim could not be normalized safely.",
      },
    };
  }

  const project = sanitizeDisplay(service.project);
  const serviceName = sanitizeDisplay(service.service);
  let allocation: DesiredPortAllocation;
  if (claim.allocation.mode === "dynamic") {
    allocation = { mode: "dynamic" };
  } else if (claim.allocation.mode === "fixed") {
    allocation = { mode: "fixed", published: { ...claim.allocation.published } };
  } else {
    allocation = { mode: "choice", published: { ...claim.allocation.published } };
  }
  const normalized: DesiredPortClaim = {
    kind: "port",
    origin: "desired",
    project,
    service: serviceName,
    family: claim.family,
    hostIp,
    protocol: claim.protocol,
    allocation,
  };

  return {
    claim: normalized,
    ownerKey: desiredPortKey(normalized),
  };
}

function normalizeRuntimePort(
  container: RuntimeContainerProjection,
  claim: RuntimePortClaim,
): NormalizedRuntimePort | NormalizationIssue {
  const interval = { ...claim.published };
  const hostIp = normalizeHostIp(claim.hostIp, claim.family);
  if (hostIp === undefined || !validPortInterval(interval)) {
    return {
      key: `runtime:${container.id}:${claim.family}:${claim.protocol}`,
      failure: {
        code: "UNSUPPORTED_RESOURCE_SHAPE",
        check: "normalization",
        message: "A runtime published-port claim could not be normalized safely.",
      },
    };
  }

  const normalized: RuntimePortClaim = {
    kind: "port",
    origin: "runtime",
    containerId: sanitizeDisplay(container.id),
    containerName: sanitizeDisplay(container.name),
    ...(container.project === undefined ? {} : { project: sanitizeDisplay(container.project) }),
    ...(container.service === undefined ? {} : { service: sanitizeDisplay(container.service) }),
    family: claim.family,
    hostIp,
    protocol: claim.protocol,
    published: interval,
  };

  return {
    claim: normalized,
    ownerKey: runtimePortKey(normalized),
  };
}

function desiredPortKey(claim: DesiredPortClaim): string {
  const allocation =
    claim.allocation.mode === "dynamic"
      ? "dynamic"
      : `${claim.allocation.mode}:${claim.allocation.published.start}-${claim.allocation.published.end}`;
  return [
    "desired",
    claim.project,
    claim.service,
    claim.family,
    claim.hostIp,
    claim.protocol,
    allocation,
  ].join("|");
}

function runtimePortKey(claim: RuntimePortClaim): string {
  return [
    "runtime",
    claim.containerId,
    claim.containerName,
    claim.family,
    claim.hostIp,
    claim.protocol,
    `${claim.published.start}-${claim.published.end}`,
  ].join("|");
}

function desiredPortParty(claim: DesiredPortClaim): PortConflictParty {
  return {
    kind: "port",
    origin: "desired",
    ownerType: "service",
    name: claim.service,
    project: claim.project,
    service: claim.service,
    claim,
  };
}

function runtimePortParty(claim: RuntimePortClaim): PortConflictParty {
  return {
    kind: "port",
    origin: "runtime",
    ownerType: "container",
    name: claim.containerName,
    containerId: claim.containerId,
    ...(claim.project === undefined ? {} : { project: claim.project }),
    ...(claim.service === undefined ? {} : { service: claim.service }),
    claim,
  };
}

function partyKey(party: ConflictParty): string {
  switch (party.kind) {
    case "port":
      return party.origin === "desired" ? desiredPortKey(party.claim) : runtimePortKey(party.claim);
    case "volume":
      return [
        party.kind,
        party.origin,
        party.ownerType,
        party.name,
        "project" in party ? party.project : "",
        "service" in party ? party.service : "",
        "volume" in party ? party.volume : "",
      ].join("|");
    case "network":
      return [
        party.kind,
        party.origin,
        party.ownerType,
        party.name,
        "project" in party ? party.project : "",
        "networkId" in party ? party.networkId : "",
        party.network,
      ].join("|");
  }
}

function sortParties<T extends ConflictParty>(parties: readonly T[]): T[] {
  return parties.slice().sort((left, right) => compareCodePoints(partyKey(left), partyKey(right)));
}

function sortResolutions(resolutions: readonly ConflictResolution[]): ConflictResolution[] {
  return resolutions.slice().sort((left, right) => compareCodePoints(left.id, right.id));
}

function changePortResolution(claim: DesiredPortClaim): ConflictResolution {
  return {
    id: resolutionId("change-compose-port", desiredPortKey(claim)),
    action: "change-compose-port",
    service: claim.service,
    message: `Manually choose a non-conflicting published port for service ${claim.service}.`,
  };
}

function runtimePortResolutions(claim: RuntimePortClaim): ConflictResolution[] {
  return [
    {
      id: resolutionId("inspect-runtime-owner", runtimePortKey(claim)),
      action: "inspect-runtime-owner",
      resourceType: "container",
      name: claim.containerName,
      message: `Inspect runtime container ${claim.containerName} and confirm that it should retain the binding.`,
    },
    {
      id: resolutionId("stop-or-reconfigure-container", runtimePortKey(claim)),
      action: "stop-or-reconfigure-container",
      container: claim.containerName,
      message: `Manually stop or reconfigure container ${claim.containerName} if it should release the binding.`,
    },
  ];
}

function buildPortConflict(
  code: "PORT_BINDING_CONFLICT" | "PORT_RANGE_EXHAUSTED",
  resource: PortServiceConflict["resource"],
  parties: readonly PortConflictParty[],
  origin: PortServiceConflict["origin"],
  resolutions: readonly ConflictResolution[],
): PortServiceConflict {
  const sortedParties = sortParties(parties);
  const key = [
    code,
    resource.family,
    resource.hostIp,
    resource.protocol,
    `${resource.published.start}-${resource.published.end}`,
    ...sortedParties.map(partyKey),
  ].join("|");
  const portLabel =
    resource.published.start === resource.published.end
      ? String(resource.published.start)
      : `${resource.published.start}-${resource.published.end}`;
  return {
    id: findingId("port", code, key),
    code,
    kind: "port",
    severity: "error",
    origin,
    message:
      code === "PORT_RANGE_EXHAUSTED"
        ? `No available ${resource.protocol.toUpperCase()} ${resource.family} host port remains in ${portLabel}.`
        : `Published ${resource.protocol.toUpperCase()} ${resource.family} host port ${portLabel} has conflicting owners.`,
    resource,
    parties: sortedParties,
    resolutions: sortResolutions(resolutions),
  };
}

export function evaluatePorts(
  services: readonly DesiredServiceProjection[],
  containers: readonly RuntimeContainerProjection[],
  scope: ConflictValidationScope,
  budget: EvaluationBudget,
): {
  readonly findings: PortServiceConflict[];
  readonly issues: NormalizationIssue[];
  readonly normalizedResources: number;
  readonly dynamic: boolean;
} {
  const issues: NormalizationIssue[] = [];
  const desired: NormalizedDesiredPort[] = [];
  const runtime: NormalizedRuntimePort[] = [];

  for (const service of services) {
    for (const claim of service.ports) {
      const normalized = normalizeDesiredPort(service, claim);
      if ("failure" in normalized) {
        issues.push(normalized);
      } else {
        desired.push(normalized);
      }
    }
  }

  const scopeServices = new Set(scope.services);
  for (const container of containers) {
    const isAuthoritativeSelf =
      container.project === scope.project &&
      container.service !== undefined &&
      scopeServices.has(container.service);
    if (isAuthoritativeSelf) {
      continue;
    }
    for (const claim of container.ports) {
      const normalized = normalizeRuntimePort(container, claim);
      if ("failure" in normalized) {
        issues.push(normalized);
      } else {
        runtime.push(normalized);
      }
    }
  }

  desired.sort((left, right) => compareCodePoints(left.ownerKey, right.ownerKey));
  runtime.sort((left, right) => compareCodePoints(left.ownerKey, right.ownerKey));

  const fixedDesired = desired.filter(
    (
      entry,
    ): entry is NormalizedDesiredPort & {
      readonly claim: DesiredPortClaim & {
        readonly allocation: { readonly mode: "fixed"; readonly published: PortInterval };
      };
    } => entry.claim.allocation.mode === "fixed",
  );
  const choiceDesired = desired.filter((entry): entry is ChoicePort => {
    return entry.claim.allocation.mode === "choice";
  });

  const findings: PortServiceConflict[] = [];
  desiredPairs: for (let leftIndex = 0; leftIndex < fixedDesired.length; leftIndex += 1) {
    const left = fixedDesired[leftIndex];
    if (left === undefined) {
      continue;
    }
    for (let rightIndex = leftIndex + 1; rightIndex < fixedDesired.length; rightIndex += 1) {
      if (!consumeComparisonWork(budget)) {
        break desiredPairs;
      }
      const right = fixedDesired[rightIndex];
      if (
        right === undefined ||
        left.claim.protocol !== right.claim.protocol ||
        left.claim.family !== right.claim.family ||
        !intervalsOverlap(left.claim.allocation.published, right.claim.allocation.published)
      ) {
        continue;
      }
      const hostIp = intersectHostIps(left.claim, right.claim);
      if (hostIp === undefined) {
        continue;
      }
      if (
        !appendFinding(
          findings,
          buildPortConflict(
            "PORT_BINDING_CONFLICT",
            {
              kind: "port",
              family: left.claim.family,
              hostIp,
              protocol: left.claim.protocol,
              published: intersectIntervals(
                left.claim.allocation.published,
                right.claim.allocation.published,
              ),
            },
            [desiredPortParty(left.claim), desiredPortParty(right.claim)],
            "desired",
            [changePortResolution(left.claim), changePortResolution(right.claim)],
          ),
          budget,
        )
      ) {
        break desiredPairs;
      }
    }
  }

  runtimePairs: for (const desiredEntry of fixedDesired) {
    for (const runtimeEntry of runtime) {
      if (!consumeComparisonWork(budget)) {
        break runtimePairs;
      }
      if (
        desiredEntry.claim.protocol !== runtimeEntry.claim.protocol ||
        desiredEntry.claim.family !== runtimeEntry.claim.family ||
        !intervalsOverlap(desiredEntry.claim.allocation.published, runtimeEntry.claim.published)
      ) {
        continue;
      }
      const hostIp = intersectHostIps(desiredEntry.claim, runtimeEntry.claim);
      if (hostIp === undefined) {
        continue;
      }
      if (
        !appendFinding(
          findings,
          buildPortConflict(
            "PORT_BINDING_CONFLICT",
            {
              kind: "port",
              family: desiredEntry.claim.family,
              hostIp,
              protocol: desiredEntry.claim.protocol,
              published: intersectIntervals(
                desiredEntry.claim.allocation.published,
                runtimeEntry.claim.published,
              ),
            },
            [desiredPortParty(desiredEntry.claim), runtimePortParty(runtimeEntry.claim)],
            "runtime",
            [
              changePortResolution(desiredEntry.claim),
              ...runtimePortResolutions(runtimeEntry.claim),
            ],
          ),
          budget,
        )
      ) {
        break runtimePairs;
      }
    }
  }

  if (budget.issue !== undefined) {
    return {
      findings,
      issues,
      normalizedResources: desired.length + runtime.length,
      dynamic: desired.some((entry) => entry.claim.allocation.mode === "dynamic"),
    };
  }

  const choiceGroups = groupBy(
    choiceDesired,
    (choice) => `${choice.claim.family}|${choice.claim.protocol}`,
  );
  for (const choices of choiceGroups.values()) {
    const representative = choices.slice().sort(compareChoicePorts)[0];
    if (representative === undefined) {
      continue;
    }
    const fixedBlockers: OccupiedPort[] = [
      ...fixedDesired.map((entry) => ({
        claim: entry.claim,
        published: entry.claim.allocation.published,
      })),
      ...runtime.map((entry) => ({
        claim: entry.claim,
        published: entry.claim.published,
      })),
    ].filter(
      (blocker) =>
        blocker.claim.family === representative.claim.family &&
        blocker.claim.protocol === representative.claim.protocol,
    );
    const assignmentResult = choiceAssignmentResult(choices, fixedBlockers, budget);
    if (assignmentResult === "exists") {
      continue;
    }
    if (assignmentResult === "inconclusive") {
      issues.push({
        key: `choice-assignment:${representative.claim.family}:${representative.claim.protocol}`,
        failure: {
          code: "EVIDENCE_LIMIT_EXCEEDED",
          check: "normalization",
          message: "Choice-port feasibility exceeded the deterministic validation work limit.",
        },
      });
      continue;
    }

    const relevantBlockers: OccupiedPort[] = [];
    blockerSearch: for (const blocker of fixedBlockers) {
      for (const choice of choices) {
        if (!consumeComparisonWork(budget)) {
          break blockerSearch;
        }
        if (
          intersectHostIps(choice.claim, blocker.claim) !== undefined &&
          intervalsOverlap(choice.claim.allocation.published, blocker.published)
        ) {
          relevantBlockers.push(blocker);
          break;
        }
      }
    }
    if (budget.issue !== undefined) {
      break;
    }
    const blockerParties = relevantBlockers.map((blocker) =>
      blocker.claim.origin === "desired"
        ? desiredPortParty(blocker.claim)
        : runtimePortParty(blocker.claim),
    );
    const blockerResolutions = relevantBlockers.flatMap((blocker) =>
      blocker.claim.origin === "desired"
        ? [changePortResolution(blocker.claim)]
        : runtimePortResolutions(blocker.claim),
    );
    if (
      !appendFinding(
        findings,
        buildPortConflict(
          "PORT_RANGE_EXHAUSTED",
          {
            kind: "port",
            family: representative.claim.family,
            hostIp: representative.claim.hostIp,
            protocol: representative.claim.protocol,
            published: { ...representative.claim.allocation.published },
          },
          [...choices.map((choice) => desiredPortParty(choice.claim)), ...blockerParties],
          relevantBlockers.some((blocker) => blocker.claim.origin === "runtime")
            ? "runtime"
            : "desired",
          [...choices.map((choice) => changePortResolution(choice.claim)), ...blockerResolutions],
        ),
        budget,
      )
    ) {
      break;
    }
  }

  return {
    findings,
    issues,
    normalizedResources: desired.length + runtime.length,
    dynamic: desired.some((entry) => entry.claim.allocation.mode === "dynamic"),
  };
}

function compareChoicePorts(left: ChoicePort, right: ChoicePort): number {
  const intervalCompare =
    left.claim.allocation.published.end - right.claim.allocation.published.end ||
    left.claim.allocation.published.start - right.claim.allocation.published.start;
  return intervalCompare || compareCodePoints(left.ownerKey, right.ownerKey);
}

function choiceAssignmentResult(
  choices: readonly ChoicePort[],
  fixedBlockers: readonly OccupiedPort[],
  budget: EvaluationBudget,
): ChoiceAssignmentResult {
  const family = choices[0]?.claim.family;
  if (family === undefined) {
    return "exists";
  }
  const wildcard = wildcardAddress(family);
  const wildcardChoices = choices
    .filter((choice) => choice.claim.hostIp === wildcard)
    .slice()
    .sort(compareChoicePorts);
  const specificGroups = groupBy(
    choices.filter((choice) => choice.claim.hostIp !== wildcard),
    (choice) => choice.claim.hostIp,
  );
  const wildcardAssignments: OccupiedPort[] = [];
  const exhaustedStates = new Set<string>();
  let work = 0;

  const consumeWork = (): boolean => {
    work += 1;
    return work <= MAX_CHOICE_ASSIGNMENT_WORK && consumeComparisonWork(budget);
  };

  const matchingBlockers = (
    choice: ChoicePort,
    blockers: readonly OccupiedPort[],
  ): OccupiedPort[] | undefined => {
    const matches: OccupiedPort[] = [];
    for (const blocker of blockers) {
      if (!consumeComparisonWork(budget)) {
        return undefined;
      }
      if (intersectHostIps(choice.claim, blocker.claim) !== undefined) {
        matches.push(blocker);
      }
    }
    return matches;
  };

  const specificAssignmentResult = (): ChoiceAssignmentResult => {
    for (const specificChoices of specificGroups.values()) {
      const assigned: OccupiedPort[] = [];
      for (const choice of specificChoices.slice().sort(compareChoicePorts)) {
        if (!consumeWork()) {
          return "inconclusive";
        }
        const blockers = matchingBlockers(choice, [
          ...fixedBlockers,
          ...wildcardAssignments,
          ...assigned,
        ]);
        if (blockers === undefined) {
          return "inconclusive";
        }
        const port = firstAvailablePort(
          choice.claim.allocation.published,
          blockers.map((blocker) => blocker.published),
          budget,
        );
        if (budget.issue !== undefined) {
          return "inconclusive";
        }
        if (port === undefined) {
          return "exhausted";
        }
        assigned.push({
          claim: choice.claim,
          published: { start: port, end: port },
        });
      }
    }
    return "exists";
  };

  const assignWildcard = (index: number): ChoiceAssignmentResult => {
    const stateKey = `${index}|${wildcardAssignments
      .map((assignment) => assignment.published.start)
      .sort((left, right) => left - right)
      .join(",")}`;
    if (exhaustedStates.has(stateKey)) {
      return "exhausted";
    }
    if (!consumeWork()) {
      return "inconclusive";
    }

    const specificResult = specificAssignmentResult();
    if (specificResult !== "exists") {
      if (specificResult === "exhausted") {
        exhaustedStates.add(stateKey);
      }
      return specificResult;
    }

    const choice = wildcardChoices[index];
    if (choice === undefined) {
      return "exists";
    }
    const blockers = matchingBlockers(choice, [...fixedBlockers, ...wildcardAssignments]);
    if (blockers === undefined) {
      return "inconclusive";
    }
    for (
      let candidate = firstAvailablePort(
        choice.claim.allocation.published,
        blockers.map((blocker) => blocker.published),
        budget,
      );
      candidate !== undefined && candidate <= choice.claim.allocation.published.end;
      candidate = firstAvailablePort(
        { start: candidate + 1, end: choice.claim.allocation.published.end },
        blockers.map((blocker) => blocker.published),
        budget,
      )
    ) {
      if (!consumeWork()) {
        return "inconclusive";
      }
      wildcardAssignments.push({
        claim: choice.claim,
        published: { start: candidate, end: candidate },
      });
      const result = assignWildcard(index + 1);
      wildcardAssignments.pop();
      if (result !== "exhausted") {
        return result;
      }
    }
    exhaustedStates.add(stateKey);
    return "exhausted";
  };

  return assignWildcard(0);
}

function firstAvailablePort(
  target: PortInterval,
  intervals: readonly PortInterval[],
  budget: EvaluationBudget,
): number | undefined {
  const sortWork =
    intervals.length <= 1
      ? intervals.length
      : Math.ceil(intervals.length * Math.log2(intervals.length));
  if (!consumeComparisonWork(budget, sortWork)) {
    return undefined;
  }
  const sorted = intervals
    .map((interval) => ({ ...interval }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  let candidate = target.start;
  for (const interval of sorted) {
    if (!consumeComparisonWork(budget)) {
      return undefined;
    }
    if (interval.end < candidate) {
      continue;
    }
    if (interval.start > candidate) {
      return candidate;
    }
    candidate = interval.end + 1;
    if (candidate > target.end) {
      return undefined;
    }
  }
  return candidate <= target.end ? candidate : undefined;
}
