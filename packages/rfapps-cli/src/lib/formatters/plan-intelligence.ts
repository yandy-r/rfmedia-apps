/**
 * Human-readable renderers for contextual plan annotations (issue #152).
 *
 * PURE: every export returns `string[]` and writes nothing. `actions/plan.ts`
 * owns emission and sends every line to stderr, so stdout stays reserved for
 * the machine payload.
 *
 * Wording here is deliberately weaker than the mechanism suggests, and the
 * phrasing is load-bearing:
 *
 * - "N services declare `depends_on` X" -- never a claim that those dependents
 *   fail. Compose `depends_on` governs start ordering, not runtime coupling,
 *   and `rfapps apply` deploys only the plan's own change set.
 * - "the locally cached image for this reference is behind the registry" --
 *   never "the running container is behind"; the registry check compares the
 *   local daemon cache against the remote manifest.
 * - "no running container found (a stopped container is not inspected)" --
 *   never "service absent".
 *
 * @module rfapps-cli/lib/formatters/plan-intelligence
 */

import { colors } from "@rfmedia/common";
import stringWidth from "string-width";

import type {
  ChangeReason,
  ChangeReasonCode,
  PlanIntelligence,
  ServiceEffect,
  ServiceImpact,
  ServiceIntelligence,
} from "../../types/plan-intelligence.js";
import type { ServiceChange } from "../../types/plan.js";

import { padToWidth } from "./width.js";

/** Display width of a `sha256:`-prefixed digest shortened for concise output. */
const DIGEST_PREFIX_WIDTH = 19;

/** Leading characters of a plan UUID shown in operator-facing lines. */
const PLAN_ID_WIDTH = 8;

/** Advisory reason that drives the plan-level registry-drift section. */
const REGISTRY_DRIFT_CODE: ChangeReasonCode = "registry-image-drifted";

/**
 * Dimension nouns used to abbreviate trigger reasons in the concise `why:` line.
 *
 * Only trigger codes appear; provenance and advisory reasons are never
 * abbreviated into the secondary clause.
 */
const TRIGGER_DIMENSION: Readonly<Partial<Record<ChangeReasonCode, string>>> = {
  "container-not-running": "runtime state",
  "image-reference-changed": "image",
  "environment-changed": "environment",
  "ports-changed": "ports",
  "volumes-changed": "volumes",
  "networks-changed": "networks",
};

/** Operator-facing phrase for what applying a service's change does. */
const EFFECT_PHRASE: Readonly<Record<ServiceEffect, string>> = {
  none: "no container change",
  create: "creates a new container",
  replace: "replaces the running container",
};

/**
 * Vocabulary for the `forces …` clause.
 *
 * The renderer receives a `ServiceIntelligence`, which carries `impact.effect`
 * but not `ServiceChange.changeType`, so the clause names the effect
 * ("replacement") rather than the specific change type ("recreate"). The change
 * type is already printed on the header line directly above by
 * `formatChangeType`, so nothing is lost.
 */
const FORCES_WORD: Readonly<Record<ServiceEffect, string | undefined>> = {
  none: undefined,
  create: "create",
  replace: "replacement",
};

/**
 * Concise (1-2) or verbose stderr lines for one service, without leading indent.
 *
 * Concise mode emits a `why:` line and — only when the service has at least one
 * declared dependent — an `impact:` line. A zero-dependent service prints no
 * `impact:` line at all: 37 of 48 services in a typical deployment have none,
 * and a reassuring "0 dependents" would invite an operator to bounce a service
 * whose real coupling (shared mounts, reverse-proxy routing) this feature does
 * not model.
 *
 * @param intelligence - annotations for one service; `undefined` renders nothing
 * @param options - `verbose` selects the full reason blocks
 * @returns lines without leading indent; the caller owns indentation and stream
 */
export function formatServiceIntelligenceLines(
  intelligence: ServiceIntelligence | undefined,
  options: { verbose: boolean },
): string[] {
  if (intelligence === undefined || intelligence.reasons.length === 0) {
    return [];
  }

  return options.verbose
    ? [...verboseReasonLines(intelligence), ...verboseImpactLines(intelligence.impact)]
    : conciseLines(intelligence);
}

/**
 * Plan-level provenance, registry-drift section, and rollup lines.
 *
 * Emitted as one block so the caller has a single insertion point. Order:
 * the downstream rollup line (indented to sit inside the `Summary:` list), the
 * registry-drift section, then the change-origin line and any degraded banner.
 *
 * The registry-drift section is the only place an `unchanged` registry-drifted
 * service ever becomes visible, since default text output iterates only the
 * create/recreate/update/delete buckets. The section gates on the image
 * reference not having moved, never on the change type, so a listed service may
 * still be changing for environment, port, volume, or network reasons.
 *
 * @param intelligence - plan annotations; `undefined` renders nothing
 * @param services - plan changes, used for drift image references and digests
 * @param options - `verbose` prints full digests instead of shortened prefixes
 * @returns lines carrying their own indentation
 */
export function formatPlanIntelligenceLines(
  intelligence: PlanIntelligence | undefined,
  services: readonly ServiceChange[],
  options: { verbose: boolean },
): string[] {
  if (intelligence === undefined) {
    return [];
  }

  const sections: string[][] = [
    downstreamRollupLines(intelligence),
    registryDriftLines(intelligence, services, options.verbose),
    provenanceLines(intelligence),
  ];

  const lines: string[] = [];
  for (const section of sections) {
    if (section.length === 0) {
      continue;
    }
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(...section);
  }
  return lines;
}

/**
 * Pick the reason that leads the concise `why:` line.
 *
 * Provenance answers "where did this come from", which is the more useful lead
 * when it exists; otherwise the top-ranked trigger explains the change type.
 * `reasons` is already ranked, so the first match of a kind is the top-ranked one.
 */
function findLeadReason(reasons: readonly ChangeReason[]): ChangeReason | undefined {
  return (
    reasons.find((reason) => reason.kind === "provenance") ??
    reasons.find((reason) => reason.kind === "trigger") ??
    reasons[0]
  );
}

/** Concise `why:` line plus the conditional `impact:` line. */
function conciseLines(intelligence: ServiceIntelligence): string[] {
  const lines: string[] = [];

  const why = conciseWhyClause(intelligence);
  if (why !== undefined) {
    lines.push(`${colors.bold("why")}: ${why}`);
  }

  const impact = conciseImpactClause(intelligence.impact);
  if (impact !== undefined) {
    lines.push(`${colors.bold("impact")}: ${impact}`);
  }

  return lines;
}

/** Lead clause, optional secondary clause, and the `[inferred]` suffix. */
function conciseWhyClause(intelligence: ServiceIntelligence): string | undefined {
  const lead = findLeadReason(intelligence.reasons);
  if (lead === undefined) {
    return undefined;
  }

  const forces =
    lead.kind === "trigger" && lead.decisive ? FORCES_WORD[intelligence.impact.effect] : undefined;
  const clauses = [forces === undefined ? lead.summary : `${lead.summary} (forces ${forces})`];

  const secondary = secondaryClause(intelligence.reasons, lead);
  if (secondary !== undefined) {
    clauses.push(secondary);
  }

  const clause = clauses.join("; ");
  return lead.confidence === "inferred" ? `${clause} ${colors.dim("[inferred]")}` : clause;
}

/**
 * Abbreviate the remaining trigger dimensions into one trailing clause.
 *
 * A provenance lead is followed by the decisive dimensions (what forced the
 * change type); a trigger lead is followed by the non-decisive ones (what else
 * moved at the same time, which a bare change type would otherwise hide).
 */
function secondaryClause(reasons: readonly ChangeReason[], lead: ChangeReason): string | undefined {
  const wantDecisive = lead.kind === "provenance";
  const names = reasons
    .filter(
      (reason) => reason !== lead && reason.kind === "trigger" && reason.decisive === wantDecisive,
    )
    .map((reason) => TRIGGER_DIMENSION[reason.code])
    .filter((name): name is string => name !== undefined);

  if (names.length === 0) {
    return undefined;
  }

  const verb = names.length === 1 ? "differs" : "differ";
  return wantDecisive ? `${names.join(", ")} ${verb}` : `${names.join(", ")} also ${verb}`;
}

/** Concise `impact:` clause, or `undefined` when the service has no dependents. */
function conciseImpactClause(impact: ServiceImpact): string | undefined {
  if (impact.dependentCount === 0) {
    return undefined;
  }

  const declaring =
    impact.dependentCount === 1
      ? "1 service declares depends_on this service"
      : `${impact.dependentCount} services declare depends_on this service`;

  return `${EFFECT_PHRASE[impact.effect]}; ${declaring} (${impact.runningDependentCount} running)`;
}

/** Verbose `why:` block: one tagged bullet per reason with indented evidence. */
function verboseReasonLines(intelligence: ServiceIntelligence): string[] {
  const lines = [`${colors.bold("why")}:`];

  for (const reason of intelligence.reasons) {
    const forces =
      reason.kind === "trigger" && reason.decisive
        ? FORCES_WORD[intelligence.impact.effect]
        : undefined;
    const tag = [
      reason.kind,
      reason.confidence,
      ...(forces === undefined ? [] : [`forces ${forces}`]),
    ].join("/");
    lines.push(`  - ${reason.summary}  ${colors.dim(`[${tag}]`)}`);
    for (const evidence of reason.evidence) {
      lines.push(`      ${colors.dim(evidence)}`);
    }
  }

  return lines;
}

/**
 * Verbose `impact:` block.
 *
 * Gated on the same zero-dependent rule as the concise line so the two modes
 * never disagree about whether a service has reported reach.
 */
function verboseImpactLines(impact: ServiceImpact): string[] {
  if (impact.dependentCount === 0) {
    return [];
  }

  const hidden = impact.dependentCount - impact.dependents.length;
  const sample = impact.dependents.join(", ");
  const listed = impact.dependentsTruncated && hidden > 0 ? `${sample} (+${hidden} more)` : sample;
  const changing =
    impact.changingDependencies.length === 0 ? "(none)" : impact.changingDependencies.join(", ");

  return [
    `${colors.bold("impact")}:`,
    `  effect: ${EFFECT_PHRASE[impact.effect]}`,
    `  core service: ${impact.critical ? "yes" : "no"}`,
    `  dependents: ${impact.dependentCount} declared (${impact.runningDependentCount} running) — ${listed}`,
    `  changing dependencies: ${changing}`,
  ];
}

/** Summary rollup line, indented to sit inside the existing `Summary:` list. */
function downstreamRollupLines(intelligence: PlanIntelligence): string[] {
  const downstream = intelligence.summary.downstreamImpacted;
  if (downstream === 0) {
    return [];
  }

  const arrow = colors.cyan("→");
  return [
    downstream === 1
      ? `  ${arrow} 1 downstream service declares depends_on a changing service`
      : `  ${arrow} ${downstream} downstream services declare depends_on a changing service`,
  ];
}

/** Registry-drift section for services whose image reference did not change. */
function registryDriftLines(
  intelligence: PlanIntelligence,
  services: readonly ServiceChange[],
  verbose: boolean,
): string[] {
  const changeByService = new Map(services.map((change) => [change.service, change]));

  const rows = Object.keys(intelligence.services)
    .filter((service) =>
      (intelligence.services[service]?.reasons ?? []).some(
        (reason) => reason.code === REGISTRY_DRIFT_CODE,
      ),
    )
    .sort()
    .map((service) => {
      const image = changeByService.get(service)?.image;
      return {
        service,
        reference: image?.canonicalImage ?? image?.desired ?? image?.current ?? "(unknown image)",
        local: shortDigest(image?.localDigest, verbose),
        remote: shortDigest(image?.remoteDigest, verbose),
      };
    });

  if (rows.length === 0) {
    return [];
  }

  const serviceWidth = maxWidth(rows.map((row) => row.service));
  const referenceWidth = maxWidth(rows.map((row) => row.reference));

  return [
    colors.bold("Registry drift (image reference unchanged, upstream image moved):"),
    ...rows.map(
      (row) =>
        `  ${padToWidth(row.service, serviceWidth)}  ${padToWidth(row.reference, referenceWidth)}  ` +
        `${colors.dim(row.local)} → ${colors.yellow(row.remote)}`,
    ),
  ];
}

/** Change-origin line plus the degraded banners, one line each. */
function provenanceLines(intelligence: PlanIntelligence): string[] {
  const lines: string[] = [];
  const { provenance } = intelligence;

  if (provenance.baseline === "previous-plan") {
    const state = provenance.composeFileChanged ? "compose file edited" : "compose file unchanged";
    lines.push(
      `Change origin: ${state} since plan ${provenance.planId.slice(0, PLAN_ID_WIDTH)} (${provenance.createdAt})`,
    );
  } else {
    const detail =
      provenance.reason === "no-comparable-plan"
        ? "no prior plan for this compose file and profile set"
        : "the plan history directory could not be read";
    lines.push(colors.dim(`Change origin: unavailable (${detail})`));
  }

  if (!intelligence.registryChecked) {
    lines.push(colors.dim("Registry drift not checked (add --check-updates)"));
  }

  if (!intelligence.runtimeStateObserved) {
    lines.push(
      colors.yellow(
        "Runtime state unavailable (docker compose ps or inspect failed); cause annotations suppressed",
      ),
    );
  }

  return lines;
}

/** Shorten a digest for concise output; verbose output keeps the full value. */
function shortDigest(digest: string | undefined, verbose: boolean): string {
  if (digest === undefined || digest === "") {
    return "(unknown)";
  }
  return verbose ? digest : digest.slice(0, DIGEST_PREFIX_WIDTH);
}

/** Widest display width in a column, for Unicode-safe alignment. */
function maxWidth(values: readonly string[]): number {
  return values.reduce((widest, value) => Math.max(widest, stringWidth(value)), 0);
}
