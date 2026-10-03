import ipaddr from "ipaddr.js";
import type {
  ConflictResolution,
  DesiredNetworkProjection,
  DesiredServiceProjection,
  NetworkServiceConflict,
  PortAddressFamily,
  RuntimeNetworkProjection,
} from "../types/validation.js";
import {
  appendFinding,
  compareCodePoints,
  consumeComparisonWork,
  type EvaluationBudget,
  findingId,
  type NormalizationIssue,
  partyKey,
  resolutionId,
  sanitizeDisplay,
  sortParties,
  sortResolutions,
} from "./conflict-evaluator-shared.js";

interface ParsedCidr {
  readonly family: PortAddressFamily;
  readonly canonical: string;
  readonly start: bigint;
  readonly end: bigint;
}

interface CidrClaim<T> {
  readonly owner: T;
  readonly cidr: ParsedCidr;
}

function bytesToBigInt(bytes: readonly number[]): bigint {
  return bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
}

function parseCidr(value: string): ParsedCidr | undefined {
  try {
    const [address, prefix] = ipaddr.parseCIDR(value.trim());
    const family = address.kind();
    const bits = family === "ipv4" ? 32 : 128;
    const hostBits = bits - prefix;
    const addressValue = bytesToBigInt(address.toByteArray());
    const endMask = hostBits === 0 ? 0n : (1n << BigInt(hostBits)) - 1n;
    const start = addressValue & ~endMask;
    const end = start | endMask;
    const networkAddress =
      family === "ipv4"
        ? ipaddr.IPv4.networkAddressFromCIDR(value.trim()).toString()
        : ipaddr.IPv6.networkAddressFromCIDR(value.trim()).toString();
    return {
      family,
      canonical: `${networkAddress}/${prefix}`,
      start,
      end,
    };
  } catch {
    return undefined;
  }
}

function desiredNetworkParty(
  project: string,
  network: DesiredNetworkProjection,
): NetworkServiceConflict["parties"][number] {
  const name = sanitizeDisplay(network.name);
  return {
    kind: "network",
    origin: "desired",
    ownerType: "network",
    name,
    project: sanitizeDisplay(project),
    network: name,
  };
}

function runtimeNetworkParty(
  network: RuntimeNetworkProjection,
): NetworkServiceConflict["parties"][number] {
  const name = sanitizeDisplay(network.name);
  return {
    kind: "network",
    origin: "runtime",
    ownerType: "network",
    name,
    networkId: sanitizeDisplay(network.id),
    network: name,
  };
}

function cidrsOverlap(left: ParsedCidr, right: ParsedCidr): boolean {
  return left.family === right.family && left.start <= right.end && right.start <= left.end;
}

function changeSubnetResolution(network: string): ConflictResolution {
  return {
    id: resolutionId("change-network-subnet", network),
    action: "change-network-subnet",
    network,
    message: `Manually choose a non-overlapping explicit subnet for network ${network}.`,
  };
}

function buildNetworkConflict(
  project: string,
  desired: CidrClaim<DesiredNetworkProjection>,
  other: CidrClaim<DesiredNetworkProjection | RuntimeNetworkProjection>,
): NetworkServiceConflict {
  const isRuntime = "id" in other.owner;
  const desiredParty = desiredNetworkParty(project, desired.owner);
  const otherParty = isRuntime
    ? runtimeNetworkParty(other.owner)
    : desiredNetworkParty(project, other.owner);
  const parties = sortParties([desiredParty, otherParty]);
  const networkName = sanitizeDisplay(desired.owner.name);
  const otherName = sanitizeDisplay(other.owner.name);
  const key = [desired.cidr.canonical, other.cidr.canonical, ...parties.map(partyKey)].join("|");
  const resolutions: ConflictResolution[] = [changeSubnetResolution(networkName)];
  if (isRuntime) {
    resolutions.push(
      {
        id: resolutionId("inspect-runtime-owner", `network:${otherName}`),
        action: "inspect-runtime-owner",
        resourceType: "network",
        name: otherName,
        message: `Inspect Docker network ${otherName} before changing either subnet.`,
      },
      {
        id: resolutionId("remove-or-reconfigure-network", otherName),
        action: "remove-or-reconfigure-network",
        network: otherName,
        message: `Manually remove or reconfigure Docker network ${otherName} only if it is safe.`,
      },
    );
  } else {
    resolutions.push(changeSubnetResolution(otherName));
  }
  return {
    id: findingId("network", "NETWORK_SUBNET_CONFLICT", key),
    code: "NETWORK_SUBNET_CONFLICT",
    kind: "network",
    severity: "error",
    origin: isRuntime ? "runtime" : "desired",
    message: `Explicit subnet ${desired.cidr.canonical} for ${networkName} overlaps ${other.cidr.canonical} for ${otherName}.`,
    resource: {
      kind: "network",
      family: desired.cidr.family,
      subnet: desired.cidr.canonical,
      overlaps: other.cidr.canonical,
    },
    parties,
    resolutions: sortResolutions(resolutions),
  };
}

export function evaluateNetworks(
  project: string,
  services: readonly DesiredServiceProjection[],
  desiredNetworks: readonly DesiredNetworkProjection[],
  runtimeNetworks: readonly RuntimeNetworkProjection[],
  budget: EvaluationBudget,
): {
  readonly findings: NetworkServiceConflict[];
  readonly issues: NormalizationIssue[];
  readonly normalizedResources: number;
  readonly autoAssigned: boolean;
} {
  const referenced = new Set(services.flatMap((service) => service.networks));
  const relevantDesired = desiredNetworks
    .filter((network) => referenced.has(network.key) || referenced.has(network.name))
    .slice()
    .sort((left, right) =>
      compareCodePoints(`${left.name}|${left.key}`, `${right.name}|${right.key}`),
    );
  const desiredClaims: Array<CidrClaim<DesiredNetworkProjection>> = [];
  const runtimeClaims: Array<CidrClaim<RuntimeNetworkProjection>> = [];
  const issues: NormalizationIssue[] = [];
  const intendedRuntimeNames = new Set(relevantDesired.map((network) => network.name));

  for (const network of relevantDesired) {
    for (const subnet of network.subnets) {
      const cidr = parseCidr(subnet);
      if (cidr === undefined) {
        issues.push({
          key: `desired:${network.name}:${sanitizeDisplay(subnet)}`,
          failure: {
            code: "INVALID_CIDR",
            check: "normalization",
            message: `An explicit subnet for desired network ${sanitizeDisplay(network.name)} is invalid.`,
          },
        });
      } else {
        desiredClaims.push({ owner: network, cidr });
      }
    }
  }
  for (const network of runtimeNetworks) {
    if (intendedRuntimeNames.has(network.name)) {
      continue;
    }
    for (const subnet of network.subnets) {
      const cidr = parseCidr(subnet);
      if (cidr === undefined) {
        issues.push({
          key: `runtime:${network.name}:${sanitizeDisplay(subnet)}`,
          failure: {
            code: "INVALID_CIDR",
            check: "normalization",
            message: `An explicit subnet for runtime network ${sanitizeDisplay(network.name)} is invalid.`,
          },
        });
      } else {
        runtimeClaims.push({ owner: network, cidr });
      }
    }
  }

  desiredClaims.sort((left, right) =>
    compareCodePoints(
      `${left.owner.name}|${left.cidr.canonical}`,
      `${right.owner.name}|${right.cidr.canonical}`,
    ),
  );
  runtimeClaims.sort((left, right) =>
    compareCodePoints(
      `${left.owner.name}|${left.owner.id}|${left.cidr.canonical}`,
      `${right.owner.name}|${right.owner.id}|${right.cidr.canonical}`,
    ),
  );

  const findings: NetworkServiceConflict[] = [];
  desiredPairs: for (let leftIndex = 0; leftIndex < desiredClaims.length; leftIndex += 1) {
    const left = desiredClaims[leftIndex];
    if (left === undefined) {
      continue;
    }
    for (let rightIndex = leftIndex + 1; rightIndex < desiredClaims.length; rightIndex += 1) {
      if (!consumeComparisonWork(budget)) {
        break desiredPairs;
      }
      const right = desiredClaims[rightIndex];
      if (
        right === undefined ||
        left.owner.name === right.owner.name ||
        !cidrsOverlap(left.cidr, right.cidr)
      ) {
        continue;
      }
      if (!appendFinding(findings, buildNetworkConflict(project, left, right), budget)) {
        break desiredPairs;
      }
    }
    for (const runtime of runtimeClaims) {
      if (!consumeComparisonWork(budget)) {
        break desiredPairs;
      }
      if (left.owner.name === runtime.owner.name || !cidrsOverlap(left.cidr, runtime.cidr)) {
        continue;
      }
      if (!appendFinding(findings, buildNetworkConflict(project, left, runtime), budget)) {
        break desiredPairs;
      }
    }
  }

  return {
    findings,
    issues,
    normalizedResources: desiredClaims.length + runtimeClaims.length,
    autoAssigned: relevantDesired.some((network) => network.subnets.length === 0),
  };
}
