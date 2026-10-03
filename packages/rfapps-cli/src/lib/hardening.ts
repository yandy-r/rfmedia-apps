/**
 * Compose hardening engine: evaluation, canonical YAML serialization, and the
 * anchor-safe patch applier behind `rfapps harden`.
 *
 * Every export is pure. The patch applier is string -> string: it never reads or
 * writes the filesystem, never logs, and never throws out of the patch path —
 * an edit it cannot make safely is reported as a HardenRefusal.
 */

import { basename } from "node:path";

import {
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  stringify,
  visit,
  type Document,
} from "yaml";

import { InvalidArgumentError } from "./errors.js";
import { HARDEN_RULES, HARDEN_RULE_IDS } from "./hardening-rules.js";
import type {
  HardenComposeConfig,
  HardenConfidence,
  HardenPatch,
  HardenProposal,
  HardenRefusal,
  HardenRefusalCode,
  HardenReformat,
  HardenRuleId,
  HardenSummary,
  HardenSuppression,
} from "../types/hardening.js";

export { HARDEN_RULES, HARDEN_RULE_IDS } from "./hardening-rules.js";
export { formatHardenRulesCatalog, formatHardenText } from "./hardening-format.js";

/**
 * Serializer options chosen by measurement, not taste: on this repo's compose.yml
 * they reduce the parse -> serialize delta from many hunks to exactly one.
 */
const COMPOSE_SERIALIZE_OPTIONS = { lineWidth: 0, flowCollectionPadding: false } as const;

/** Canonical serialization used for every write and for reformat detection. */
export function serializeComposeDocument(doc: Document): string {
  return doc.toString(COMPOSE_SERIALIZE_OPTIONS);
}

function countLines(text: string): number {
  return text.split("\n").length;
}

/**
 * Disclosure of churn `--apply` would cause on lines harden did not target. Pure.
 *
 * `lineDelta` is signed (serialized minus source) and is negative when the
 * canonical serializer collapses a multi-line flow sequence onto one line.
 */
export function detectReformat(source: string): HardenReformat {
  const serialized = serializeComposeDocument(parseDocument(source));
  return {
    wouldReformat: serialized !== source,
    lineDelta: countLines(serialized) - countLines(source),
  };
}

const VALID_SUPPRESSION_RULES: readonly string[] = [...HARDEN_RULE_IDS, "*"];

/**
 * Normalize and validate `harden.ignore[]` entries.
 *
 * @param entries - Raw suppression entries from configuration
 * @returns Entries with lowercased, trimmed rule ids and service names
 * @throws {InvalidArgumentError} When an entry references an unknown rule id
 */
export function normalizeHardenSuppressions(
  entries: readonly HardenSuppression[],
): readonly HardenSuppression[] {
  return entries.map((entry) => {
    const rule = entry.rule === "*" ? "*" : entry.rule.toLowerCase().trim();
    if (!VALID_SUPPRESSION_RULES.includes(rule)) {
      throw new InvalidArgumentError("harden.ignore[].rule", entry.rule, "unknown harden rule id", [
        ...VALID_SUPPRESSION_RULES,
      ]);
    }
    return {
      rule: rule as HardenRuleId | "*",
      ...(entry.service === undefined ? {} : { service: entry.service.toLowerCase().trim() }),
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    };
  });
}

/**
 * Parse a comma-separated `--rule` allowlist.
 *
 * @param csv - Raw option value, or undefined when the flag was not given
 * @returns undefined when no allowlist was given (all rules run)
 * @throws {InvalidArgumentError} On an unknown rule id
 */
export function parseHardenRuleIds(csv: string | undefined): readonly HardenRuleId[] | undefined {
  if (csv === undefined) {
    return undefined;
  }

  const entries = csv
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");

  if (entries.length === 0) {
    return undefined;
  }

  for (const entry of entries) {
    if (!HARDEN_RULE_IDS.includes(entry as HardenRuleId)) {
      throw new InvalidArgumentError("--rule", entry, "unknown harden rule id", [
        ...HARDEN_RULE_IDS,
      ]);
    }
  }

  return entries as readonly HardenRuleId[];
}

const CONFIDENCE_RANK: Record<HardenConfidence, number> = { safe: 0, review: 1, advisory: 2 };
const DECLARATION_ORDER = new Map<HardenRuleId, number>(
  HARDEN_RULES.map((rule, index) => [rule.id, index]),
);

function isSuppressed(
  ruleId: HardenRuleId,
  serviceName: string,
  suppressions: readonly HardenSuppression[],
): boolean {
  const normalizedService = serviceName.toLowerCase().trim();
  return suppressions.some(
    (entry) =>
      (entry.rule === "*" || entry.rule === ruleId) &&
      (entry.service === undefined || entry.service === normalizedService),
  );
}

/**
 * An empty or absent allowlist means the FULL catalog.
 *
 * @throws {InvalidArgumentError} On an unknown rule id
 */
function selectRules(rules: readonly HardenRuleId[] | undefined): typeof HARDEN_RULES {
  if (rules === undefined || rules.length === 0) {
    return HARDEN_RULES;
  }

  const allowed = new Set<string>();
  for (const id of rules) {
    if (!HARDEN_RULE_IDS.includes(id)) {
      throw new InvalidArgumentError("harden.rules", String(id), "unknown harden rule id", [
        ...HARDEN_RULE_IDS,
      ]);
    }
    allowed.add(id);
  }

  return HARDEN_RULES.filter((rule) => allowed.has(rule.id));
}

function sortProposals(proposals: HardenProposal[]): HardenProposal[] {
  return proposals.slice().sort((left, right) => {
    const confidence = CONFIDENCE_RANK[left.confidence] - CONFIDENCE_RANK[right.confidence];
    if (confidence !== 0) {
      return confidence;
    }
    const service = left.service.localeCompare(right.service);
    if (service !== 0) {
      return service;
    }
    return (DECLARATION_ORDER.get(left.ruleId) ?? 0) - (DECLARATION_ORDER.get(right.ruleId) ?? 0);
  });
}

/**
 * Evaluate resolved compose configuration against the harden rule catalog.
 *
 * @param config - Resolved configuration from `docker compose config`
 * @param targets - Service names to evaluate (undefined evaluates all services)
 * @param options - Suppressions and an optional rule allowlist
 * @returns Proposals sorted confidence -> service -> declaration order, plus the suppressed count
 * @throws {InvalidArgumentError} On unknown service targets or unknown rule ids
 */
export function evaluateHardening(
  config: HardenComposeConfig,
  targets: readonly string[] | undefined,
  options: {
    readonly suppressions: readonly HardenSuppression[];
    readonly rules?: readonly HardenRuleId[];
  },
): { readonly proposals: readonly HardenProposal[]; readonly suppressed: number } {
  const suppressions = normalizeHardenSuppressions(options.suppressions);
  const rules = selectRules(options.rules);

  if (targets !== undefined) {
    const missing = targets.filter((name) => config.services[name] === undefined);
    if (missing.length > 0) {
      throw new InvalidArgumentError(
        "services",
        missing.join(","),
        "unknown service target(s)",
        Object.keys(config.services).sort(),
      );
    }
  }

  const serviceNames = (targets ?? Object.keys(config.services)).slice().sort();
  const proposals: HardenProposal[] = [];
  let suppressed = 0;

  for (const serviceName of serviceNames) {
    const service = config.services[serviceName];
    if (service === undefined) {
      continue;
    }

    for (const rule of rules) {
      const detected = rule.detect(service, serviceName);
      if (detected === undefined) {
        continue;
      }
      if (isSuppressed(rule.id, serviceName, suppressions)) {
        suppressed += 1;
        continue;
      }
      proposals.push({
        ruleId: rule.id,
        service: serviceName,
        category: rule.category,
        severity: rule.severity,
        confidence: detected.confidence ?? rule.confidence,
        title: rule.title,
        rationale: rule.rationale,
        guidance: rule.guidance,
        detects: rule.detects,
        evidence: detected.evidence,
        ...(detected.note === undefined ? {} : { note: detected.note }),
        patches: rule.propose(service),
      });
    }
  }

  return { proposals: sortProposals(proposals), suppressed };
}

/**
 * Proposals eligible for a write: they carry at least one patch and a
 * confidence the run allows. Advisory is always excluded.
 */
export function filterWritableProposals(
  proposals: readonly HardenProposal[],
  includeReview: boolean,
): readonly HardenProposal[] {
  return proposals.filter(
    (proposal) =>
      proposal.patches.length > 0 &&
      (proposal.confidence === "safe" || (includeReview && proposal.confidence === "review")),
  );
}

function refusalFor(
  code: HardenRefusalCode,
  proposal: HardenProposal,
  detail: string,
  alternative: string,
): HardenRefusal {
  return { code, service: proposal.service, ruleId: proposal.ruleId, detail, alternative };
}

function isNullNode(node: unknown): boolean {
  return node === undefined || node === null || (isScalar(node) && node.value === null);
}

function isScalarValue(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function sortRefusals(refusals: HardenRefusal[]): HardenRefusal[] {
  return refusals.slice().sort((left, right) => {
    const service = left.service.localeCompare(right.service);
    return service !== 0 ? service : left.ruleId.localeCompare(right.ruleId);
  });
}

/** Anchor names some alias elsewhere in the document resolves to. */
function referencedAnchors(doc: Document): ReadonlySet<string> {
  const names = new Set<string>();
  visit(doc, {
    Alias: (_key, node) => {
      names.add(node.source);
    },
  });
  return names;
}

/** The shared anchor carried by `node`, if any. An unreferenced anchor is safe. */
function sharedAnchorOn(node: unknown, shared: ReadonlySet<string>): string | undefined {
  if (!isNode(node) || isAlias(node)) {
    return undefined;
  }
  const anchor = node.anchor;
  return anchor !== undefined && shared.has(anchor) ? anchor : undefined;
}

/** Apply one patch, or return the refusal that explains why it was withheld. */
function applyPatch(
  doc: Document,
  shared: ReadonlySet<string>,
  proposal: HardenProposal,
  patch: HardenPatch,
): HardenRefusal | undefined {
  const service = proposal.service;

  if (patch.key.includes(".") || patch.key.includes("/") || patch.key.trim() === "") {
    return refusalFor(
      "nested-path",
      proposal,
      `patch key "${patch.key}" is not a single top-level service key`,
      "internal invariant violation: harden only writes single top-level service keys; report this",
    );
  }

  if (!isMap(doc.getIn(["services", service], true))) {
    return refusalFor(
      "service-missing",
      proposal,
      `services.${service} is not defined in this compose document`,
      "the service is defined outside this compose file; use --out to emit an override fragment",
    );
  }

  const existing = doc.getIn(["services", service, patch.key], true);

  // Load-bearing guard: writing through an alias rewrites the shared anchor.
  if (isAlias(existing)) {
    return refusalFor(
      "alias-target",
      proposal,
      `services.${service}.${patch.key} is a YAML alias (*${existing.source}); editing it would change every service that shares the anchor`,
      `use: rfapps harden --rule ${proposal.ruleId} --out compose.harden.yaml`,
    );
  }

  // The guard above covers the alias side. This covers the anchor side: writing
  // into a node other services alias or `<<:`-merge reconfigures every sharer,
  // and replacing an anchored node orphans the aliases that still point at it.
  const anchor =
    sharedAnchorOn(existing, shared) ??
    sharedAnchorOn(doc.getIn(["services", service], true), shared) ??
    sharedAnchorOn(doc.get("services", true), shared);
  if (anchor !== undefined) {
    return refusalFor(
      "alias-target",
      proposal,
      `services.${service}.${patch.key} is inside the anchored node &${anchor}; editing it would change every service that shares the anchor`,
      `use: rfapps harden --rule ${proposal.ruleId} --out compose.harden.yaml`,
    );
  }

  switch (patch.operation) {
    case "set":
      // Safe on a `<<:`-merged service: creates a local key that overrides the merge.
      doc.setIn(["services", service, patch.key], patch.value);
      return undefined;

    case "merge-unique": {
      if (!Array.isArray(patch.value) || !patch.value.every(isScalarValue)) {
        return refusalFor(
          "unexpected-node",
          proposal,
          `merge-unique value for services.${service}.${patch.key} is not a sequence of scalars`,
          "internal invariant violation: report this",
        );
      }
      if (isNullNode(existing)) {
        doc.setIn(["services", service, patch.key], patch.value);
        return undefined;
      }
      if (!isSeq(existing)) {
        return refusalFor(
          "unexpected-node",
          proposal,
          `services.${service}.${patch.key} is not a sequence`,
          "edit the key by hand, or use --out to emit an override fragment",
        );
      }
      const present = new Set(
        existing.items.map((item) => {
          // An alias item already supplies its anchor's value; treating it as
          // unknown appends a literal duplicate of what it resolves to.
          const resolved = isAlias(item) ? item.resolve(doc) : item;
          return isScalar(resolved) ? String(resolved.value) : undefined;
        }),
      );
      for (const entry of patch.value) {
        const key = String(entry);
        if (present.has(key)) {
          continue;
        }
        existing.add(entry);
        present.add(key);
      }
      return undefined;
    }
  }
}

/**
 * Apply writable proposals to compose source. Pure string -> string.
 *
 * Returns the source unchanged when nothing was written, so a run that refuses
 * every patch never reformats the operator's file.
 *
 * @param source - Raw compose file contents
 * @param proposals - Writable proposals from {@link filterWritableProposals}
 * @returns Patched content, the write counts, and every refusal encountered
 */
export function applyHardenPatches(
  source: string,
  proposals: readonly HardenProposal[],
): {
  readonly content: string;
  readonly patchesWritten: number;
  readonly servicesPatched: readonly string[];
  readonly refusals: readonly HardenRefusal[];
} {
  const doc = parseDocument(source);

  if (!isMap(doc.get("services"))) {
    return {
      content: source,
      patchesWritten: 0,
      servicesPatched: [],
      refusals: [
        {
          code: "unexpected-node",
          service: "*",
          ruleId: "*",
          detail: "compose document has no services map",
          alternative:
            "check that the compose file parses and declares a top-level `services:` mapping",
        },
      ],
    };
  }

  const refusals: HardenRefusal[] = [];
  const patched = new Set<string>();
  const shared = referencedAnchors(doc);
  let patchesWritten = 0;

  for (const proposal of proposals) {
    for (const patch of proposal.patches) {
      const refusal = applyPatch(doc, shared, proposal, patch);
      if (refusal !== undefined) {
        refusals.push(refusal);
        continue;
      }
      patchesWritten += 1;
      patched.add(proposal.service);
    }
  }

  return {
    content: patchesWritten > 0 ? serializeComposeDocument(doc) : source,
    patchesWritten,
    servicesPatched: [...patched].sort(),
    refusals: sortRefusals(refusals),
  };
}

/**
 * Compose override document containing only the writable patches. "" when none.
 *
 * Sequence-valued patches carry the full union computed from the resolved config,
 * because a compose override REPLACES sequences rather than appending to them.
 */
export function buildHardenOverride(
  proposals: readonly HardenProposal[],
  meta: {
    readonly composePath: string;
    readonly timestamp: string;
    readonly includeReview: boolean;
  },
): { readonly content: string; readonly patchesWritten: number } {
  const services: Record<string, Record<string, unknown>> = {};
  let patchesWritten = 0;

  for (const proposal of proposals) {
    for (const patch of proposal.patches) {
      const entry = services[proposal.service] ?? {};
      entry[patch.key] = patch.value;
      services[proposal.service] = entry;
      patchesWritten += 1;
    }
  }

  if (patchesWritten === 0) {
    return { content: "", patchesWritten: 0 };
  }

  const header = [
    `# Generated by rfapps harden at ${meta.timestamp}`,
    `# Source: ${meta.composePath}`,
    `# Apply with: docker compose -f ${basename(meta.composePath)} -f compose.harden.yaml up -d`,
    meta.includeReview
      ? "# Includes review-confidence rules. Verify each workload before applying."
      : "# Safe-confidence rules only. Re-run with --include-review to include review rules.",
  ].join("\n");

  return { content: `${header}\n${stringify({ services }, { lineWidth: 0 })}`, patchesWritten };
}

/**
 * Aggregate proposal, suppression, write, and refusal counts.
 *
 * `applied` is 0 in propose mode; `suppressed` comes from {@link evaluateHardening}.
 */
export function buildHardenSummary(
  proposals: readonly HardenProposal[],
  suppressed: number,
  applied: number,
  refusals: readonly HardenRefusal[],
): HardenSummary {
  const byConfidence = (confidence: HardenConfidence): number =>
    proposals.filter((proposal) => proposal.confidence === confidence).length;

  return {
    total: proposals.length,
    safe: byConfidence("safe"),
    review: byConfidence("review"),
    advisory: byConfidence("advisory"),
    suppressed,
    servicesAffected: new Set(proposals.map((proposal) => proposal.service)).size,
    applied,
    refused: refusals.length,
  };
}
