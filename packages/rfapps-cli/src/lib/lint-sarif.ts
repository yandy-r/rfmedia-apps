/**
 * SARIF 2.1.0 serializer for rfapps lint results.
 *
 * Hand-built without external dependencies for GitHub code scanning integration.
 */

import type { LintFinding, LintResult, LintRule, LintRuleId, LintSeverity } from "../types/lint.js";

/** SARIF result severity level */
export type SarifLevel = "error" | "warning" | "note";

/** SARIF message with required text */
export interface SarifMessage {
  /** Human-readable message (must be non-empty) */
  text: string;
}

/** SARIF artifact location within a run */
export interface SarifArtifactLocation {
  /** Relative path to the artifact */
  uri: string;
  /** Base id for resolving relative URIs */
  uriBaseId: string;
}

/** SARIF region within an artifact */
export interface SarifRegion {
  /** 1-based start line */
  startLine: number;
}

/** SARIF physical location for a result */
export interface SarifPhysicalLocation {
  /** File or artifact reference */
  artifactLocation: SarifArtifactLocation;
  /** Line region within the artifact */
  region: SarifRegion;
}

/** SARIF location entry for a result */
export interface SarifLocation {
  /** Physical file location */
  physicalLocation: SarifPhysicalLocation;
}

/** SARIF tool rule definition */
export interface SarifRule {
  /** Rule identifier matching result.ruleId */
  id: LintRuleId;
  /** Short rule name */
  name: string;
  /** Brief rule summary */
  shortDescription: SarifMessage;
  /** Full rule description */
  fullDescription: SarifMessage;
  /** Default severity when the rule fires */
  defaultConfiguration: {
    level: SarifLevel;
  };
}

/** SARIF result properties for lint enrichment */
export interface SarifResultProperties {
  /** Advisory grouping tags */
  tags: LintFinding["group"][];
  /** Optional workload context note */
  contextNote?: string;
}

/** SARIF result for a single lint finding */
export interface SarifResult {
  /** Rule that produced this result */
  ruleId: LintRuleId;
  /** Severity of this result */
  level: SarifLevel;
  /** Finding message */
  message: SarifMessage;
  /** Where the finding applies */
  locations: SarifLocation[];
  /** Lint-specific enrichment for consumers */
  properties: SarifResultProperties;
}

/** SARIF tool driver metadata */
export interface SarifToolDriver {
  /** Tool name */
  name: string;
  /** Rule catalog for this run */
  rules: SarifRule[];
}

/** SARIF tool descriptor */
export interface SarifTool {
  /** Tool driver containing rules */
  driver: SarifToolDriver;
}

/** Single analysis run in a SARIF log */
export interface SarifRun {
  /** Tool that produced results */
  tool: SarifTool;
  /** Findings from the run */
  results: SarifResult[];
}

/** SARIF 2.1.0 log document */
export interface SarifLog {
  /** JSON schema reference */
  $schema: string;
  /** SARIF version */
  version: "2.1.0";
  /** Analysis runs */
  runs: SarifRun[];
}

const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";

const DEFAULT_COMPOSE_ARTIFACT_URI = "compose.yml";
const COMPOSE_URI_BASE_ID = "%SRCROOT%";
const SYNTHETIC_START_LINE = 1;

/**
 * Map lint severity to SARIF result level.
 */
function severityToLevel(severity: LintSeverity): SarifLevel {
  switch (severity) {
    case "error":
      return "error";
    case "warn":
      return "warning";
    case "info":
      return "note";
    default: {
      const exhaustive: never = severity;
      return exhaustive;
    }
  }
}

/**
 * Convert a lint rule definition to a SARIF tool rule.
 */
function mapRuleToSarifRule(rule: LintRule): SarifRule {
  return {
    id: rule.id,
    name: rule.title,
    shortDescription: { text: rule.title },
    fullDescription: { text: rule.rationale },
    defaultConfiguration: {
      level: severityToLevel(rule.severity),
    },
  };
}

/**
 * Ensure result message text is non-empty for SARIF consumers.
 */
function resolveMessageText(finding: LintFinding, rules: LintRule[]): string {
  const trimmed = finding.message.trim();
  if (trimmed.length > 0) {
    return trimmed;
  }

  const rule = rules.find((entry) => entry.id === finding.ruleId);
  if (rule !== undefined) {
    return `${finding.service}: ${rule.title}`;
  }

  return `${finding.service}: Production readiness finding`;
}

/**
 * Convert a lint finding to a SARIF result.
 */
function mapFindingToSarifResult(
  finding: LintFinding,
  rules: LintRule[],
  composePath: string,
): SarifResult {
  const properties: SarifResultProperties = {
    tags: [finding.group],
  };

  if (finding.contextNote !== undefined) {
    properties.contextNote = finding.contextNote;
  }

  return {
    ruleId: finding.ruleId,
    level: severityToLevel(finding.severity),
    message: {
      text: resolveMessageText(finding, rules),
    },
    locations: [
      {
        physicalLocation: {
          artifactLocation: {
            uri: composePath,
            uriBaseId: COMPOSE_URI_BASE_ID,
          },
          region: {
            startLine: SYNTHETIC_START_LINE,
          },
        },
      },
    ],
    properties,
  };
}

/**
 * Serialize lint analysis results to a SARIF 2.1.0 log.
 */
export function toSarif(
  result: LintResult,
  rules: LintRule[],
  composePath: string = DEFAULT_COMPOSE_ARTIFACT_URI,
): SarifLog {
  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "rfapps-lint",
            rules: rules.map(mapRuleToSarifRule),
          },
        },
        results: result.findings.map((finding) =>
          mapFindingToSarifResult(finding, rules, composePath),
        ),
      },
    ],
  };
}
