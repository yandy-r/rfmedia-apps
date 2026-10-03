/**
 * Pure renderers for `rfapps harden` terminal output.
 *
 * Both renderers return plain lines; the calling action writes them to stderr.
 * No colours, no snapshots, no filesystem or logging access.
 */

import { basename } from "node:path";

import { HARDEN_RULES } from "./hardening-rules.js";
import type { HardenConfidence, HardenProposal, HardenResult } from "../types/hardening.js";

const CONFIDENCE_SECTIONS: readonly { confidence: HardenConfidence; heading: string }[] = [
  { confidence: "safe", heading: "SAFE - write with `rfapps harden --apply`" },
  {
    confidence: "review",
    heading: "REVIEW - verify the workload first: `rfapps harden --apply --include-review`",
  },
  { confidence: "advisory", heading: "ADVISORY - no safe automatic value exists" },
];

const ADVISORY_PATCH_PLACEHOLDER = "(advisory - no automatic value)";

/** "lint/no-new-privileges-missing, audit/cap-drop-missing"; undefined when both absent. */
function detectsLabel(detects: HardenProposal["detects"]): string | undefined {
  const parts: string[] = [];
  if (detects.lint !== undefined) {
    parts.push(`lint/${detects.lint}`);
  }
  if (detects.audit !== undefined) {
    parts.push(`audit/${detects.audit}`);
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function headerLines(result: HardenResult): string[] {
  const write = result.write;

  if (write.mode === "override") {
    return ["Security Hardening  (mode: override)", `Override written: ${write.path}`];
  }

  if (write.mode === "apply") {
    const lines = ["Security Hardening  (mode: apply)"];
    if (write.backupPath !== undefined) {
      lines.push(`Backup: ${write.backupPath}`);
    }
    return lines;
  }

  return ["Security Hardening Proposals  (mode: propose -- nothing written)"];
}

function scopeLine(result: HardenResult): string {
  const services = result.scope.services;
  const profiles = result.scope.profiles;
  const serviceLabel = services.length > 0 ? services.join(", ") : "all services";
  const profileLabel = profiles.length > 0 ? profiles.join(", ") : "none";
  return `Scope: ${serviceLabel} (profiles: ${profileLabel})`;
}

function summaryLine(result: HardenResult): string {
  const summary = result.summary;
  return (
    `Proposals: ${summary.total} total - ${summary.safe} safe, ${summary.review} review, ` +
    `${summary.advisory} advisory | ${summary.suppressed} suppressed | ${summary.refused} refused`
  );
}

function proposalLines(proposal: HardenProposal): string[] {
  const [first, ...rest] = proposal.patches;
  const lines = [
    `    ${proposal.severity}  ${proposal.ruleId}  ${first?.description ?? ADVISORY_PATCH_PLACEHOLDER}`,
  ];

  for (const patch of rest) {
    lines.push(`          ${patch.description}`);
  }

  lines.push(`      evidence: ${proposal.evidence.join("; ")}`);
  if (proposal.note !== undefined) {
    lines.push(`      note: ${proposal.note}`);
  }
  if (proposal.confidence === "advisory") {
    lines.push(`      guidance: ${proposal.guidance}`);
  }
  const detects = detectsLabel(proposal.detects);
  if (detects !== undefined) {
    lines.push(`      detects: ${detects}`);
  }

  return lines;
}

function sectionLines(heading: string, proposals: readonly HardenProposal[]): string[] {
  const lines = ["", heading];
  let currentService: string | undefined;

  for (const proposal of proposals) {
    if (proposal.service !== currentService) {
      currentService = proposal.service;
      lines.push(`  ${currentService}`);
    }
    lines.push(...proposalLines(proposal));
  }

  return lines;
}

function refusalLines(result: HardenResult): string[] {
  if (result.refusals.length === 0) {
    return [];
  }

  const lines = ["", "REFUSED - reported, not written"];
  for (const refusal of result.refusals) {
    lines.push(`  ${refusal.service}  ${refusal.ruleId}  ${refusal.detail}`);
    lines.push(`  -> ${refusal.alternative}`);
  }
  return lines;
}

function reformatLines(result: HardenResult): string[] {
  if (!result.reformat.wouldReformat) {
    return [];
  }

  return [
    "",
    "Note: writing compose.yml would also reformat lines this command did not target",
    `(line delta: ${result.reformat.lineDelta}). --apply requires --allow-reformat, or use --out.`,
  ];
}

function appliedLines(result: HardenResult): string[] {
  const write = result.write;
  if (write.mode !== "apply") {
    return [];
  }

  const lines = [
    `Applied ${write.patchesWritten} patch(es) to ${write.servicesPatched.length} service(s); ` +
      `${result.summary.review} review and ${result.summary.advisory} advisory proposal(s) untouched.`,
  ];
  if (result.summary.refused > 0) {
    lines.push(`Refused ${result.summary.refused} patch(es) (see above). Exit code 3 (partial).`);
  }
  return lines;
}

function overrideLines(result: HardenResult): string[] {
  if (result.override === "" || result.write.mode === "apply") {
    return [];
  }

  const composeFile = basename(result.scope.composePath);
  return [
    "",
    `Compose override fragment (usable as \`docker compose -f ${composeFile} -f compose.harden.yaml up -d\`):`,
    "",
    ...result.override.split("\n"),
  ];
}

/** Render a harden result for terminal output (stderr). */
export function formatHardenText(result: HardenResult): string[] {
  const lines = [
    ...headerLines(result),
    `Compose: ${result.scope.composePath}`,
    scopeLine(result),
    summaryLine(result),
  ];

  if (result.proposals.length === 0) {
    lines.push("", "No hardening proposals.");
  } else {
    for (const section of CONFIDENCE_SECTIONS) {
      const proposals = result.proposals.filter((p) => p.confidence === section.confidence);
      if (proposals.length === 0) {
        continue;
      }
      lines.push(...sectionLines(section.heading, proposals));
    }
  }

  lines.push(...refusalLines(result));
  lines.push(...reformatLines(result));
  lines.push(...appliedLines(result));
  lines.push(...overrideLines(result));

  return lines;
}

/** Render the rule catalog for `rfapps harden --list-rules`. */
export function formatHardenRulesCatalog(): string[] {
  const lines = [`Harden Rules (${HARDEN_RULES.length})`];

  for (const rule of HARDEN_RULES) {
    lines.push(
      "",
      `  ${rule.id}  ${rule.severity}  ${rule.category}  ${rule.confidence}`,
      `    ${rule.title}`,
      `    ${rule.rationale}`,
      `    Guidance: ${rule.guidance}`,
      `    Detects: ${detectsLabel(rule.detects) ?? "-"}`,
    );
  }

  return lines;
}
