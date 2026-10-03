import type {
  ConflictParty,
  ConflictValidationResult,
  ServiceConflict,
} from "../../types/validation.js";

export interface ConflictValidationTableRow {
  field: string;
  value: string;
}

function describeOwner(party: ConflictParty): string {
  switch (party.kind) {
    case "port":
      return party.ownerType === "service"
        ? `desired service ${party.project}/${party.service}`
        : `runtime container ${party.name}`;
    case "volume":
      return party.ownerType === "service"
        ? `desired service ${party.project}/${party.service}`
        : `${party.origin} volume ${party.name}`;
    case "network":
      return `${party.origin} network ${party.name}`;
  }
}

function appendFindingRows(
  rows: ConflictValidationTableRow[],
  section: "conflict" | "warning",
  finding: ServiceConflict,
  findingIndex: number,
): void {
  const displayIndex = findingIndex + 1;
  rows.push({
    field: `${section}[${displayIndex}]`,
    value: `[${finding.kind}] ${finding.message} (${finding.id}; ${finding.code})`,
  });
  finding.parties.forEach((party, ownerIndex) => {
    rows.push({
      field: `${section} owner[${displayIndex}.${ownerIndex + 1}]`,
      value: describeOwner(party),
    });
  });
  finding.resolutions.forEach((resolution, resolutionIndex) => {
    rows.push({
      field: `${section} resolution[${displayIndex}.${resolutionIndex + 1}]`,
      value: resolution.message,
    });
  });
}

/** Project conflict-validation evidence into flat rows suitable for the real table renderer. */
export function projectConflictValidationTable(
  result: ConflictValidationResult,
): ConflictValidationTableRow[] {
  const rows: ConflictValidationTableRow[] = [
    { field: "decision", value: result.status.toUpperCase() },
    { field: "scope project", value: result.scope.project },
  ];

  if (result.scope.services.length === 0) {
    rows.push({ field: "scope services", value: "none" });
  } else {
    result.scope.services.forEach((service, index) => {
      rows.push({ field: `scope service[${index + 1}]`, value: service });
    });
  }

  if (result.scope.profiles.length === 0) {
    rows.push({ field: "scope profiles", value: "none" });
  } else {
    result.scope.profiles.forEach((profile, index) => {
      rows.push({ field: `scope profile[${index + 1}]`, value: profile });
    });
  }

  rows.push({
    field: "summary",
    value: `${result.summary.total} total; ${result.summary.errors} blocking; ${result.summary.warnings} warnings; ${result.summary.ports} ports; ${result.summary.volumes} volumes; ${result.summary.networks} networks`,
  });

  result.checks.forEach((check) => {
    const requirement = check.required ? "required" : "optional";
    rows.push({
      field: `check ${check.id}`,
      value: `${check.status.toUpperCase()}; ${requirement}; ${check.resources} resources`,
    });
    if (check.status !== "passed") {
      rows.push({
        field: `check ${check.id} failure`,
        value: `${check.failure.message} (${check.failure.code})`,
      });
    }
  });

  if (result.status === "inconclusive") {
    rows.push({
      field: "evidence failure",
      value: `${result.error.message} (${result.error.code})`,
    });
  }

  if (result.conflicts.length === 0) {
    rows.push({ field: "conflicts", value: "none" });
  } else {
    result.conflicts.forEach((finding, index) => {
      appendFindingRows(rows, "conflict", finding, index);
    });
  }

  if (result.warnings.length === 0) {
    rows.push({ field: "warnings", value: "none" });
  } else {
    result.warnings.forEach((finding, index) => {
      appendFindingRows(rows, "warning", finding, index);
    });
  }

  if (result.limitations.length === 0) {
    rows.push({ field: "limitations", value: "none" });
  } else {
    result.limitations.forEach((limitation, index) => {
      const kind = limitation.kind === undefined ? "" : `${limitation.kind}; `;
      rows.push({
        field: `limitation[${index + 1}]`,
        value: `${kind}${limitation.message} (${limitation.code})`,
      });
    });
  }

  return rows;
}
