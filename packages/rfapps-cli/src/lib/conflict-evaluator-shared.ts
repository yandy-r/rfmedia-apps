import type {
  ConflictParty,
  ConflictResolution,
  ConflictValidationFailure,
  DesiredPortClaim,
  RuntimePortClaim,
  ServiceConflict,
  ServiceConflictCode,
} from "../types/validation.js";

const MAX_DISPLAY_LENGTH = 160;
const MAX_COMPARISON_WORK = 499_500;
const MAX_FINDINGS = 496;
const UNSAFE_DISPLAY_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

export interface NormalizationIssue {
  readonly key: string;
  readonly failure: ConflictValidationFailure;
}

export interface EvaluationBudget {
  comparisonWork: number;
  findings: number;
  issue?: NormalizationIssue;
}

export function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function sanitizeDisplay(value: string, fallback = "unknown"): string {
  const sanitized = value
    .replace(UNSAFE_DISPLAY_CHARACTERS, "?")
    .trim()
    .slice(0, MAX_DISPLAY_LENGTH);
  return sanitized === "" ? fallback : sanitized;
}

function budgetIssue(key: "comparisons" | "findings"): NormalizationIssue {
  return {
    key: `budget:${key}`,
    failure: {
      code: "EVIDENCE_LIMIT_EXCEEDED",
      check: "normalization",
      message:
        key === "comparisons"
          ? "Resource comparison work exceeded the deterministic validation limit."
          : "Conflict findings exceeded the deterministic validation limit.",
    },
  };
}

export function consumeComparisonWork(budget: EvaluationBudget, work = 1): boolean {
  if (budget.issue !== undefined) return false;
  budget.comparisonWork += work;
  if (budget.comparisonWork <= MAX_COMPARISON_WORK) return true;
  budget.issue = budgetIssue("comparisons");
  return false;
}

export function appendFinding<T extends ServiceConflict>(
  findings: T[],
  finding: T,
  budget: EvaluationBudget,
): boolean {
  if (budget.issue !== undefined) return false;
  budget.findings += 1;
  if (budget.findings <= MAX_FINDINGS) {
    findings.push(finding);
    return true;
  }
  budget.issue = budgetIssue("findings");
  return false;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function findingId(
  kind: ServiceConflict["kind"],
  code: ServiceConflictCode,
  key: string,
): string {
  return `${kind}-${code.toLowerCase().replaceAll("_", "-")}-${stableHash(key)}`;
}

export function resolutionId(action: ConflictResolution["action"], key: string): string {
  return `resolution-${action}-${stableHash(key)}`;
}

export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => sanitizeDisplay(value)))].sort(compareCodePoints);
}

export function groupBy<T>(values: readonly T[], keyFor: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}

export function desiredPortKey(claim: DesiredPortClaim): string {
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

export function runtimePortKey(claim: RuntimePortClaim): string {
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

export function partyKey(party: ConflictParty): string {
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

export function sortParties<T extends ConflictParty>(parties: readonly T[]): T[] {
  return parties.slice().sort((left, right) => compareCodePoints(partyKey(left), partyKey(right)));
}

export function sortResolutions(resolutions: readonly ConflictResolution[]): ConflictResolution[] {
  return resolutions.slice().sort((left, right) => compareCodePoints(left.id, right.id));
}

export function normalizeDriver(driver: string): string {
  const normalized = driver.trim().toLowerCase();
  return normalized === "" ? "local" : normalized;
}
