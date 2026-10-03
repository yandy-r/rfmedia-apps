/**
 * Human rendering and CSV schemas for `rfmedia lidarr policy evaluate|plan`
 * (#209, #311).
 *
 * This module owns EVERY byte of policy rendering, which is what keeps
 * `src/commands/lidarr-policy.ts` inside the command-file size budget. The
 * precedent is `./lidarr-mutation-presenter.js` (1022 lines): a presenter split
 * out of a command is deliberately exempt from the ~500-line soft cap.
 *
 * OUTPUT BOUNDARY — the single load-bearing invariant here: nothing in this
 * module writes to stdout. Every human line goes through {@link writeLine},
 * which is `console.error`. stdout belongs exclusively to the machine envelope
 * the command emits through `formatOutput`, so `--output json | jq` stays
 * clean. The command layer also owns `process.exitCode`; this module never
 * touches it.
 *
 * IMPORT DISCIPLINE: only `../types/lidarr-policy.js` (zero value imports) and
 * pure formatting utilities. Nothing from `./lidarr.js` (that is the ESM cycle
 * the leaf commands exist to avoid) and nothing from `../actions/**` (a static
 * action import would defeat the command's lazy-load guarantee).
 */

import pc from "picocolors";

import { displayWidth, truncateToWidth } from "../lib/terminal-table.js";
import {
  POLICY_HUMAN_ROW_CAP,
  POLICY_RULE_DESCRIPTORS,
  POLICY_RULE_IDS,
  POLICY_SIGNALS,
} from "../types/lidarr-policy.js";
import type {
  PolicyEvaluationReport,
  PolicyEvaluatedProposal,
  PolicyHandoff,
  PolicyObservation,
  PolicyOverrideResult,
  PolicyProposal,
  PolicyResolvedRule,
  PolicyRuleId,
  PolicyRuleResult,
  PolicySkip,
  PolicySubject,
  PolicyThresholdCheck,
} from "../types/lidarr-policy.js";
import type {
  LidarrPolicyPlanReport,
  PolicyPlanCohort,
  PolicyPlanOutcome,
} from "../types/lidarr-policy-plan.js";

/* ── CSV schema (design §10.4) ───────────────────────────────────────────── */

/**
 * Stable CSV schema: one `summary` row, then one `rule` row per registered
 * rule, then one row per proposal, skip, and configured override, sharing a flat
 * file through the `rowType` discriminator.
 *
 * The shared serializer supports only two levels of nesting, so every compound
 * cell (`before`, `after`, `checks`, `observations`, `handoff.argv`) is carried
 * as a `JSON.stringify`d `*Json` column rather than as nested dot paths.
 */
export const LIDARR_POLICY_EVALUATE_CSV_COLUMNS = [
  "rowType",
  "evaluatedAt",
  "status",
  "summary.proposed",
  "summary.skipped",
  "summary.suppressed",
  "summary.staleOverrides",
  "summary.notEvaluatedOverrides",
  "summary.rulesRun",
  "summary.rulesSkipped",
  "rule.id",
  "rule.title",
  "rule.status",
  "rule.proposedCount",
  "rule.skippedCount",
  "rule.skipReason",
  "decision.key",
  "decision.ruleId",
  "decision.code",
  "decision.evidenceFingerprint",
  "decision.subject.name",
  "decision.subject.plexId",
  "decision.subject.artistId",
  "decision.subject.artistMbid",
  "decision.identity.category",
  "decision.identity.reason",
  "decision.summary",
  "decision.detail",
  "decision.handoff.producer",
  "decision.beforeJson",
  "decision.afterJson",
  "decision.checksJson",
  "decision.observationsJson",
  "decision.handoffArgvJson",
  "override.key",
  "override.action",
  "override.status",
  "override.staleReason",
  "override.reason",
  "override.expectedEvidenceFingerprint",
  "override.currentEvidenceFingerprint",
  "coverage.plexArtistsExamined",
  "coverage.plexTracksExamined",
  "coverage.authoritativeLinks",
  "coverage.nonAuthoritativeArtists",
  "coverage.ambiguousNameArtists",
  "coverage.sentinelArtistTracks",
  "coverage.unjoinedTracks",
  "coverage.totalPlaysObserved",
] as const;

/** Stable flat schema for policy-plan CSV output. */
export const LIDARR_POLICY_PLAN_CSV_COLUMNS = [
  ...LIDARR_POLICY_EVALUATE_CSV_COLUMNS,
  "plan.schema",
  "plan.mode",
  "plan.status",
  "plan.summary.proposals",
  "plan.summary.projectable",
  "plan.summary.refused",
  "plan.summary.artifacts",
  "plan.failure.stage",
  "plan.failure.producer",
  "plan.failure.detail",
  "cohort.producer",
  "cohort.target",
  "cohort.artistIdsJson",
  "cohort.decisionKeysJson",
  "cohort.changeCount",
  "refusal.code",
  "refusal.producer",
  "refusal.artistId",
  "refusal.detail",
  "refusal.remedy",
  "artifact.producer",
  "artifact.planPath",
  "artifact.planId",
  "artifact.planChecksum",
  "artifact.operation",
  "artifact.decisionKeysJson",
] as const;

/* ── Presentation constants ──────────────────────────────────────────────── */

/** Verbosity switch for the human render. */
export interface PolicyPresentationOptions {
  /**
   * Show every proposal and individual skip, and lift the cap on active
   * suppressions. Review-required override rows are always shown.
   */
  readonly verbose: boolean;
}

/** Appended to any section header whose rows were elided. */
const ROW_CAP_HINT = " — rerun with --verbose to show all";

/** Indent of a table's first column. */
const TABLE_INDENT = "  ";

/** Blank columns between two rendered cells. */
const COLUMN_GAP = 2;

/** Width of the label gutter in the report footer (`Policy`, `Signals`, …). */
const FOOTER_LABEL_WIDTH = 8;

/** Width of the value gutter in the `--explain` head block. */
const EXPLAIN_VALUE_WIDTH = 44;

/** Wrap width for a rule description in the self-teaching table. */
const DESCRIPTION_WRAP_WIDTH = 54;

/** Per-cell display caps for the proposals table. */
const PROPOSAL_KEY_WIDTH = 40;
const PROPOSAL_ARTIST_WIDTH = 24;
const PROPOSAL_BASIS_WIDTH = 32;
const PROPOSAL_STATE_WIDTH = 16;

/** Per-cell display caps for the skip views. */
const SKIP_DETAIL_WIDTH = 56;

/** Deterministic thousands separators, independent of the host locale. */
const COUNT_FORMAT = new Intl.NumberFormat("en-US");

/**
 * The cap-cut ranking each rule applies before trimming an oversized cohort
 * (design §16.3).
 *
 * §16.3 nominally assigns this disclosure to each rule's `description`, but §4's
 * `POLICY_RULE_DESCRIPTORS` strings are frozen contract and are printed verbatim
 * in the self-teaching table, so the disclosure lives here (and in the feature
 * doc) instead. It is printed only when a `cohort-cap-exceeded` skip proves a cut
 * actually happened, together with the fact that this ranking is NOT the order
 * the report displays its rows in.
 */
const POLICY_CAP_RANKINGS: Readonly<Record<PolicyRuleId, string>> = Object.freeze({
  "rating-quality-upgrade": "rating desc, lidarrId asc",
  "stale-monitoring-cleanup": "plays asc, lidarrId asc (least-consumed first)",
  "discovery-seed": "rating desc, plays desc, plexId asc",
});

/** The one identity sentence every decision is measured against. */
const IDENTITY_RULE_SENTENCE =
  "Only a unique one-to-one exact artist-MBID join may carry a proposal.";

/* ── Output boundary ─────────────────────────────────────────────────────── */

/**
 * Writes one human line to stderr.
 *
 * The single choke point for this module's output boundary: stdout is reserved
 * for the machine envelope, so every human line in this file goes through here.
 */
function writeLine(line = ""): void {
  console.error(line);
}

/* ── Plain-text table primitives ─────────────────────────────────────────── */

/** One column of a plain (border-free) aligned table. */
interface PolicyTextColumn {
  readonly title: string;
  readonly align: "left" | "right";
}

/** One row, plus any continuation lines rendered beneath it. */
interface PolicyTextRow {
  readonly cells: readonly string[];
  /** Continuation lines, indented under {@link PolicyTextTable.noteColumn}. */
  readonly notes?: readonly string[];
}

/**
 * A plain aligned table.
 *
 * `console-table-printer` is deliberately not used here: the policy layouts
 * need continuation lines beneath a row (the rule table's `└ …` note and the
 * self-teaching table's wrapped descriptions), which a bordered table cannot
 * express.
 */
interface PolicyTextTable {
  readonly columns: readonly PolicyTextColumn[];
  readonly rows: readonly PolicyTextRow[];
  /** Left indent for the whole table. Defaults to two spaces. */
  readonly indent?: string;
  /** Whether to print the column titles. Defaults to `true`. */
  readonly showHeader?: boolean;
  /** Column a row's notes align under. Defaults to the second column. */
  readonly noteColumn?: number;
  /** Explicit note indent, overriding {@link PolicyTextTable.noteColumn}. */
  readonly noteIndent?: string;
}

/** Pads one cell to a display width, honouring its alignment. */
function padCell(text: string, width: number, align: "left" | "right"): string {
  const padding = " ".repeat(Math.max(0, width - displayWidth(text)));
  return align === "right" ? `${padding}${text}` : `${text}${padding}`;
}

/** Renders a plain aligned table to stderr. */
function renderTextTable(table: PolicyTextTable): void {
  const indent = table.indent ?? TABLE_INDENT;
  const showHeader = table.showHeader !== false;
  // A suppressed title must not widen its column, or a header nobody sees would
  // pad every row beneath it.
  const widths = table.columns.map((column, index) =>
    table.rows.reduce(
      (widest, row) => Math.max(widest, displayWidth(row.cells[index] ?? "")),
      showHeader ? displayWidth(column.title) : 0,
    ),
  );
  const gap = " ".repeat(COLUMN_GAP);
  const formatRow = (cells: readonly string[]): string => {
    const rendered = table.columns.map((column, index) =>
      padCell(cells[index] ?? "", widths[index] ?? 0, column.align),
    );
    return `${indent}${rendered.join(gap)}`.trimEnd();
  };

  if (showHeader) {
    writeLine(pc.dim(formatRow(table.columns.map((column) => column.title))));
  }

  const noteColumn = table.noteColumn ?? 1;
  const noteIndent =
    table.noteIndent ??
    indent +
      " ".repeat(
        widths.slice(0, noteColumn).reduce((total, width) => total + width + COLUMN_GAP, 0),
      );

  for (const row of table.rows) {
    writeLine(formatRow(row.cells));
    for (const note of row.notes ?? []) {
      writeLine(`${noteIndent}${note}`.trimEnd());
    }
  }
}

/** Greedily wraps prose to a maximum display width. */
function wrapText(text: string, width: number): readonly string[] {
  const words = text.split(/\s+/u).filter((word) => word.length > 0);
  if (words.length === 0) {
    return [];
  }
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (displayWidth(candidate) > width && current !== "") {
      lines.push(current);
      current = word;
      continue;
    }
    current = candidate;
  }
  lines.push(current);
  return lines;
}

/* ── Scalar formatting ───────────────────────────────────────────────────── */

/** Formats a count with thousands separators. */
function formatCount(value: number): string {
  return COUNT_FORMAT.format(value);
}

/**
 * Trims sub-second precision off the evaluation stamp.
 *
 * The machine envelope keeps full ISO precision; the human header does not need
 * it and the reference render in §10.2 does not show it.
 */
function formatEvaluatedAt(evaluatedAt: string): string {
  return evaluatedAt.replace(/\.\d+Z$/u, "Z");
}

/** Renders a threshold bound or observation exactly as the contract carries it. */
function formatCheckValue(value: number | boolean | string | null): string {
  return String(value);
}

/**
 * Renders a flat before/after state record as one operator-readable cell.
 *
 * String-valued fields win when present (`{ qualityProfileId, qualityProfileName }`
 * renders as the profile name, not the id), a lone boolean renders as its own
 * field name (`monitored` / `not monitored`), and anything else falls back to
 * explicit `key value` pairs.
 */
function formatState(state: Readonly<Record<string, string | number | boolean | null>>): string {
  const entries = Object.entries(state);
  if (entries.length === 0) {
    return "-";
  }
  const strings = entries.filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  if (strings.length > 0) {
    return strings.map(([, value]) => value).join(" · ");
  }
  const [single] = entries;
  if (entries.length === 1 && single !== undefined && typeof single[1] === "boolean") {
    return single[1] ? single[0] : `not ${single[0]}`;
  }
  return entries.map(([key, value]) => `${key} ${formatCheckValue(value)}`).join(" · ");
}

/** Renders the before → after transition of one proposal. */
function formatStateTransition(proposal: PolicyProposal): string {
  const keys = [...new Set([...Object.keys(proposal.before), ...Object.keys(proposal.after)])];
  if (keys.length === 0) {
    return "no state change recorded";
  }
  return keys
    .map(
      (key) =>
        `${key} ${formatCheckValue(proposal.before[key] ?? null)} -> ${formatCheckValue(
          proposal.after[key] ?? null,
        )}`,
    )
    .join(" · ");
}

/**
 * Quotes one argv token for literal reuse in a shell.
 *
 * `handoff.argv` is a machine argument vector, never shell text; this is a
 * display concern only, so tokens that need no quoting are printed bare exactly
 * as §10.2 shows them.
 */
function quoteArgvToken(token: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(token) ? token : `'${token.replaceAll("'", `'"'"'`)}'`;
}

/** Renders an inert handoff as the command an operator would run next. */
function formatHandoffCommand(argv: readonly string[]): string {
  return `rfmedia ${argv.map(quoteArgvToken).join(" ")}`;
}

/** One-line subject label used by the `--explain` head block. */
function formatSubject(subject: PolicySubject): string {
  const facts = [
    `plex ${subject.plexId}`,
    subject.artistId === undefined ? undefined : `lidarr ${subject.artistId}`,
    subject.artistMbid === null ? undefined : `mbid ${truncateToWidth(subject.artistMbid, 9)}`,
  ].filter((fact): fact is string => fact !== undefined);
  return `${subject.name}  (${facts.join(" · ")})`;
}

/* ── Rule-level helpers ──────────────────────────────────────────────────── */

/** The `skipped` arm of a per-rule result. */
type PolicySkippedRule = Extract<PolicyRuleResult, { status: "skipped" }>;

/** Narrows a per-rule result to its `skipped` arm. */
function isSkippedRule(result: PolicyRuleResult): result is PolicySkippedRule {
  return result.status === "skipped";
}

/** The dotted config key that toggles one rule. */
function ruleEnableKey(ruleId: PolicyRuleId): string {
  return `policy.rules.${ruleId}.enabled`;
}

/**
 * Explains a rule-level skip.
 *
 * A `disabled` skip always names the exact `.rfmedia.yaml` key that turns the
 * rule on, derived from the rule id rather than from the engine's prose, so the
 * self-teaching contract holds no matter what detail the engine attached.
 */
function describeRuleSkip(result: PolicySkippedRule): string {
  if (result.skipReason === "disabled") {
    return `disabled in ${ruleEnableKey(result.id)}`;
  }
  return `${result.skipReason}: ${result.detail}`;
}

/**
 * Pairs every registered rule id with its reported result.
 *
 * The report contract says every registered rule appears exactly once, and the
 * self-teaching render depends on that. Driving the render off
 * {@link POLICY_RULE_IDS} rather than off `report.rules` makes it structurally
 * true, and makes an engine that dropped a rule visible instead of silent.
 */
function registeredRuleResults(
  report: PolicyEvaluationReport,
): readonly (readonly [PolicyRuleId, PolicyRuleResult | undefined])[] {
  return POLICY_RULE_IDS.map(
    (ruleId) => [ruleId, report.rules.find((result) => result.id === ruleId)] as const,
  );
}

/* ── CSV projection ──────────────────────────────────────────────────────── */

/** Projects one proposal into its flat CSV row. */
function projectProposalCsvRow(proposal: PolicyEvaluatedProposal): Record<string, unknown> {
  return {
    rowType: "proposal",
    "decision.key": proposal.key,
    "decision.ruleId": proposal.ruleId,
    "decision.code": proposal.code,
    "decision.evidenceFingerprint": proposal.evidenceFingerprint,
    "decision.subject.name": proposal.subject.name,
    "decision.subject.plexId": proposal.subject.plexId,
    "decision.subject.artistId": proposal.subject.artistId,
    "decision.subject.artistMbid": proposal.subject.artistMbid,
    "decision.identity.category": proposal.identity.category,
    "decision.identity.reason": proposal.identity.reason,
    "decision.summary": proposal.summary,
    "decision.handoff.producer": proposal.handoff.producer,
    "decision.beforeJson": JSON.stringify(proposal.before),
    "decision.afterJson": JSON.stringify(proposal.after),
    "decision.checksJson": JSON.stringify(proposal.checks),
    "decision.observationsJson": JSON.stringify(proposal.observations),
    "decision.handoffArgvJson": JSON.stringify(proposal.handoff.argv),
  };
}

/** Whether an override retained a proposal rather than a current refusal. */
function isEvaluatedProposal(
  decision: PolicyEvaluatedProposal | PolicySkip,
): decision is PolicyEvaluatedProposal {
  return "evidenceFingerprint" in decision;
}

/** Projects one configured override and its retained current evidence. */
function projectOverrideCsvRow(override: PolicyOverrideResult): Record<string, unknown> {
  const decision =
    override.decision === null
      ? {}
      : isEvaluatedProposal(override.decision)
        ? projectProposalCsvRow(override.decision)
        : projectSkipCsvRow(override.decision);
  return {
    ...decision,
    rowType: "override",
    "override.key": override.key,
    "override.action": override.action,
    "override.status": override.status,
    "override.staleReason": override.staleReason,
    "override.reason": override.reason,
    "override.expectedEvidenceFingerprint": override.expectedEvidenceFingerprint,
    "override.currentEvidenceFingerprint": override.currentEvidenceFingerprint,
  };
}

/** Projects one skip into its flat CSV row. */
function projectSkipCsvRow(skip: PolicySkip): Record<string, unknown> {
  return {
    rowType: "skip",
    "decision.key": skip.key,
    "decision.ruleId": skip.ruleId,
    "decision.code": skip.code,
    "decision.subject.name": skip.subject.name,
    "decision.subject.plexId": skip.subject.plexId,
    "decision.subject.artistId": skip.subject.artistId,
    "decision.subject.artistMbid": skip.subject.artistMbid,
    "decision.identity.category": skip.identity.category,
    "decision.identity.reason": skip.identity.reason,
    "decision.detail": skip.detail,
    "decision.checksJson": JSON.stringify(skip.checks),
  };
}

/**
 * Projects an evaluation report into the flat multi-row CSV records described by
 * {@link LIDARR_POLICY_EVALUATE_CSV_COLUMNS}.
 *
 * @param report - A completed evaluation report.
 * @returns One `summary` row, one row per registered rule, then one row per
 *   proposal, skip, and configured override.
 */
export function projectPolicyEvaluationCsv(
  report: PolicyEvaluationReport,
): readonly Record<string, unknown>[] {
  const summary: Record<string, unknown> = {
    rowType: "summary",
    evaluatedAt: report.evaluatedAt,
    status: report.status,
    "summary.proposed": report.summary.proposed,
    "summary.skipped": report.summary.skipped,
    "summary.suppressed": report.summary.suppressed,
    "summary.staleOverrides": report.summary.staleOverrides,
    "summary.notEvaluatedOverrides": report.summary.notEvaluatedOverrides,
    "summary.rulesRun": report.summary.rulesRun,
    "summary.rulesSkipped": report.summary.rulesSkipped,
    "coverage.plexArtistsExamined": report.coverage.plexArtistsExamined,
    "coverage.plexTracksExamined": report.coverage.plexTracksExamined,
    "coverage.authoritativeLinks": report.coverage.authoritativeLinks,
    "coverage.nonAuthoritativeArtists": report.coverage.nonAuthoritativeArtists,
    "coverage.ambiguousNameArtists": report.coverage.ambiguousNameArtists,
    "coverage.sentinelArtistTracks": report.coverage.sentinelArtistTracks,
    "coverage.unjoinedTracks": report.coverage.unjoinedTracks,
    "coverage.totalPlaysObserved": report.coverage.totalPlaysObserved,
  };
  return [
    summary,
    ...report.rules.map((result) => ({
      rowType: "rule",
      "rule.id": result.id,
      "rule.title": result.title,
      "rule.status": result.status,
      "rule.proposedCount": isSkippedRule(result) ? undefined : result.proposedCount,
      "rule.skippedCount": isSkippedRule(result) ? undefined : result.skippedCount,
      "rule.skipReason": isSkippedRule(result) ? result.skipReason : undefined,
    })),
    ...report.proposals.map(projectProposalCsvRow),
    ...report.skips.map(projectSkipCsvRow),
    ...report.overrides.map(projectOverrideCsvRow),
  ];
}

/** Scalar target carried by one homogeneous producer cohort. */
function policyPlanCohortTarget(cohort: PolicyPlanCohort): number | boolean {
  switch (cohort.producer) {
    case "artist-profile-assignment":
      return cohort.qualityProfileId;
    case "artist-monitoring":
      return cohort.monitored;
  }
}

/** Projects a policy-plan report into its fixed multi-row CSV schema. */
export function projectPolicyPlanCsv(
  report: LidarrPolicyPlanReport,
): readonly Record<string, unknown>[] {
  const evaluationRows = projectPolicyEvaluationCsv(report.evaluation);
  const evaluationSummary = evaluationRows.find((row) => row["rowType"] === "summary") ?? {};
  const ruleRows = evaluationRows.filter((row) => row["rowType"] === "rule");
  const decisionRows = evaluationRows.filter(
    (row) =>
      row["rowType"] === "proposal" || row["rowType"] === "skip" || row["rowType"] === "override",
  );
  return [
    {
      ...evaluationSummary,
      rowType: "summary",
      "plan.schema": report.schema,
      "plan.mode": report.mode,
      "plan.status": report.status,
      "plan.summary.proposals": report.summary.proposals,
      "plan.summary.projectable": report.summary.projectable,
      "plan.summary.refused": report.summary.refused,
      "plan.summary.artifacts": report.summary.artifacts,
      "plan.failure.stage": report.failure?.stage,
      "plan.failure.producer": report.failure?.producer,
      "plan.failure.detail": report.failure?.detail,
    },
    ...ruleRows,
    ...report.cohorts.map((cohort) => ({
      rowType: "cohort",
      "cohort.producer": cohort.producer,
      "cohort.target": policyPlanCohortTarget(cohort),
      "cohort.artistIdsJson": JSON.stringify(cohort.artistIds),
      "cohort.decisionKeysJson": JSON.stringify(cohort.changes.map((change) => change.decisionKey)),
      "cohort.changeCount": cohort.changes.length,
    })),
    ...decisionRows,
    ...report.refusals.map((refusal) => ({
      rowType: "refusal",
      "decision.key": refusal.decisionKey,
      "refusal.code": refusal.code,
      "refusal.producer": refusal.producer,
      "refusal.artistId": refusal.artistId,
      "refusal.detail": refusal.detail,
      "refusal.remedy": refusal.remedy,
    })),
    ...report.outcomes.map((outcome) => ({
      rowType: "artifact",
      "artifact.producer": outcome.producer,
      "artifact.planPath": outcome.generated.planPath,
      "artifact.planId": outcome.generated.plan.id,
      "artifact.planChecksum": outcome.generated.plan.payloadChecksum,
      "artifact.operation": outcome.generated.plan.operation.kind,
      "artifact.decisionKeysJson": JSON.stringify(outcome.decisionKeys),
    })),
  ];
}

/* ── Human render — sections ─────────────────────────────────────────────── */

/** Renders the two header lines of a full report. */
function renderHeader(report: PolicyEvaluationReport): void {
  writeLine();
  writeLine(
    pc.bold(`Consumption policy evaluation — ${report.plexLibrary} @ ${report.plexOrigin}`),
  );
}

/** Colours the report status without changing its wording. */
function colorStatus(status: PolicyEvaluationReport["status"]): string {
  switch (status) {
    case "clean":
      return pc.green(status);
    case "proposals":
      return pc.cyan(status);
    case "degraded":
      return pc.yellow(status);
    default: {
      const exhaustive: never = status;
      return String(exhaustive);
    }
  }
}

/** Renders the per-rule verdict table of a full report. */
function renderRuleTable(report: PolicyEvaluationReport): void {
  const rows: PolicyTextRow[] = [];
  for (const [ruleId, result] of registeredRuleResults(report)) {
    if (result === undefined) {
      rows.push({
        cells: [ruleId, "missing", "-", "-"],
        notes: ["└ the engine reported no result for this registered rule"],
      });
      continue;
    }
    if (isSkippedRule(result)) {
      rows.push({
        cells: [ruleId, "skipped", "-", "-"],
        notes: [`└ ${describeRuleSkip(result)}`],
      });
      continue;
    }
    rows.push({
      cells: [ruleId, result.status, String(result.proposedCount), String(result.skippedCount)],
    });
  }
  renderTextTable({
    columns: [
      { title: "Rule", align: "left" },
      { title: "Status", align: "left" },
      { title: "Proposed", align: "right" },
      { title: "Skipped", align: "right" },
    ],
    rows,
  });
}

/**
 * Compresses a proposal's causal basis into one cell.
 *
 * The LAST configured (non-structural) satisfied check is the decisive one: an
 * evaluator emits its skip at the FIRST blocking cause, so a proposal is what
 * survives every check in order. Any observation the engine could not make is
 * appended, because "unrated" is as much a part of the reason as the threshold.
 */
function describeProposalBasis(proposal: PolicyProposal): string {
  const clauses: string[] = [];
  const configured = proposal.checks.filter(
    (check) => check.configPath !== null && check.satisfied,
  );
  const decisive = configured.at(-1);
  if (decisive !== undefined) {
    clauses.push(
      `${decisive.label} ${formatCheckValue(decisive.observed)} ${decisive.comparator} ${formatCheckValue(decisive.bound)}`,
    );
  }
  for (const observation of Object.values(proposal.observations)) {
    if (observation.status === "unavailable") {
      clauses.push(observation.reason);
    }
  }
  return clauses.length === 0 ? proposal.summary : clauses.join(", ");
}

/** Renders the proposals table, capped unless `--verbose` was passed. */
function renderProposals(report: PolicyEvaluationReport, verbose: boolean): void {
  const { proposals } = report;
  if (proposals.length === 0) {
    writeLine(pc.green("  No proposals."));
    writeLine();
    return;
  }
  const visible = verbose ? proposals : proposals.slice(0, POLICY_HUMAN_ROW_CAP);
  const elided = visible.length < proposals.length;
  writeLine(pc.bold(`  Proposals (${proposals.length})${elided ? ROW_CAP_HINT : ""}`));
  renderTextTable({
    columns: [
      { title: "Key", align: "left" },
      { title: "Artist", align: "left" },
      { title: "Because", align: "left" },
      { title: "Before", align: "left" },
      { title: "After", align: "left" },
    ],
    rows: visible.map((proposal) => ({
      cells: [
        truncateToWidth(proposal.key, PROPOSAL_KEY_WIDTH),
        truncateToWidth(proposal.subject.name, PROPOSAL_ARTIST_WIDTH),
        truncateToWidth(describeProposalBasis(proposal), PROPOSAL_BASIS_WIDTH),
        truncateToWidth(formatState(proposal.before), PROPOSAL_STATE_WIDTH),
        truncateToWidth(formatState(proposal.after), PROPOSAL_STATE_WIDTH),
      ],
    })),
  });
  writeLine();
}

/** Color-independent lifecycle label for one configured override. */
function overrideStateLabel(override: PolicyOverrideResult): string {
  if (override.status === "suppressed") {
    return "ACTIVE SUPPRESSION";
  }
  if (override.status === "not-evaluated") {
    return "NOT EVALUATED";
  }
  return "STALE — REVIEW REQUIRED";
}

/** Exact effect and safe recovery distinction for one override lifecycle state. */
function overrideEffect(override: PolicyOverrideResult): string {
  if (override.status === "suppressed") {
    return "Active suppression; the reviewed proposal is withheld from producer cohorts.";
  }
  if (override.status === "not-evaluated") {
    return "The rule did not run; rerun with it enabled and selected before changing this record.";
  }
  switch (override.staleReason) {
    case "evidence-changed":
      return "Material proposal evidence changed; the current proposal is withheld pending review.";
    case "outcome-changed":
      return "The proposal became a refusal; the real refusal remains visible and no proposal was synthesized.";
    case "decision-absent":
      return "No matching decision exists in this completed evaluation; investigate convergence or identity drift before removing an obsolete record.";
    case null:
      return "Review required; the current decision is withheld.";
  }
}

/** Short table-only recognition token; copy-grade hashes remain in CSV and `--explain`. */
function recognitionFingerprint(value: string | null): string {
  return value === null ? "—" : truncateToWidth(value, 20);
}

/**
 * Renders configured override state for policy evaluate, policy plan, and ratings sync.
 *
 * Review-required rows are never hidden. Only active suppressions may be capped
 * in the non-verbose view, and the header keeps their complete count visible.
 */
export function renderPolicyOverrides(
  report: PolicyEvaluationReport,
  options: PolicyPresentationOptions,
): void {
  const suppressed = report.overrides.filter((override) => override.status === "suppressed");
  const visibleSuppressed = new Set(
    options.verbose ? suppressed : suppressed.slice(0, POLICY_HUMAN_ROW_CAP),
  );
  const visible = report.overrides.filter(
    (override) => override.status !== "suppressed" || visibleSuppressed.has(override),
  );
  const elided = visible.length < report.overrides.length;

  writeLine(
    pc.bold(`  Overrides (${formatCount(report.overrides.length)})${elided ? ROW_CAP_HINT : ""}`),
  );
  if (report.overrides.length === 0) {
    writeLine("    None configured.");
    writeLine();
    return;
  }

  renderTextTable({
    columns: [
      { title: "Key", align: "left" },
      { title: "State", align: "left" },
      { title: "Artist", align: "left" },
      { title: "Expected", align: "left" },
      { title: "Current", align: "left" },
    ],
    rows: visible.map((override) => ({
      cells: [
        override.key,
        overrideStateLabel(override),
        override.decision?.subject.name ?? "—",
        recognitionFingerprint(override.expectedEvidenceFingerprint),
        recognitionFingerprint(override.currentEvidenceFingerprint),
      ],
      notes: [`Reason: ${override.reason}`, `Effect: ${overrideEffect(override)}`],
    })),
    indent: "    ",
  });
  if (report.summary.staleOverrides > 0) {
    writeLine(
      "    Review required: use --explain <key> and follow the state-specific recovery guidance.",
    );
  }
  writeLine();
}

/** Prose for one follow-up cohort. */
function describeHandoff(producer: PolicyHandoff["producer"], count: number): string {
  switch (producer) {
    case "artist-profile-assignment":
      return `Review a quality-profile change for ${count} artist(s)`;
    case "artist-monitoring":
      return `Review unmonitoring ${count} unconsumed artist(s)`;
    case "discovery":
      return `Review ${count} discovery seed(s)`;
    default: {
      const exhaustive: never = producer;
      return String(exhaustive);
    }
  }
}

/**
 * Renders the deduplicated `Suggested follow-up` block.
 *
 * Deduplication is keyed on the argument vector itself: an evaluator builds one
 * cohort-wide argv and attaches it to every proposal in that cohort, so keying
 * on anything coarser would either print the same command N times or merge two
 * genuinely different invocations.
 */
function renderFollowUp(report: PolicyEvaluationReport): void {
  const cohorts = new Map<string, { readonly handoff: PolicyHandoff; count: number }>();
  for (const proposal of report.proposals) {
    const key = JSON.stringify(proposal.handoff.argv);
    const existing = cohorts.get(key);
    if (existing === undefined) {
      cohorts.set(key, { handoff: proposal.handoff, count: 1 });
      continue;
    }
    existing.count += 1;
  }
  if (cohorts.size === 0) {
    return;
  }
  writeLine(pc.bold("  Suggested follow-up"));
  for (const { handoff, count } of cohorts.values()) {
    writeLine(`    ${describeHandoff(handoff.producer, count)}`);
    writeLine(pc.dim(`      ${formatHandoffCommand(handoff.argv)}`));
  }
  writeLine();
}

/**
 * Renders the skip section.
 *
 * Default view is a rollup by skip code — 21 refusals across three causes read
 * better than 21 rows — and `--verbose` switches to one row per refusal, since
 * a refusal is data and must stay individually inspectable.
 */
function renderSkips(report: PolicyEvaluationReport, verbose: boolean): void {
  const { skips } = report;
  if (skips.length === 0) {
    return;
  }
  if (verbose) {
    writeLine(pc.bold(`  Skipped (${skips.length})`));
    renderTextTable({
      columns: [
        { title: "Key", align: "left" },
        { title: "Code", align: "left" },
        { title: "Detail", align: "left" },
      ],
      rows: skips.map((skip) => ({
        cells: [skip.key, skip.code, truncateToWidth(skip.detail, SKIP_DETAIL_WIDTH)],
      })),
      indent: "    ",
    });
    writeLine();
    return;
  }

  const rollup = new Map<string, { count: number; readonly detail: string }>();
  for (const skip of skips) {
    const existing = rollup.get(skip.code);
    if (existing === undefined) {
      rollup.set(skip.code, { count: 1, detail: skip.detail });
      continue;
    }
    existing.count += 1;
  }
  const ordered = [...rollup.entries()].sort((left, right) => {
    const byCount = right[1].count - left[1].count;
    return byCount === 0 ? left[0].localeCompare(right[0]) : byCount;
  });
  const visible = ordered.slice(0, POLICY_HUMAN_ROW_CAP);
  writeLine(pc.bold(`  Skipped (${skips.length})${ROW_CAP_HINT}`));
  renderTextTable({
    columns: [
      { title: "Code", align: "left" },
      { title: "Count", align: "right" },
      { title: "Detail", align: "left" },
    ],
    rows: visible.map(([code, entry]) => ({
      cells: [code, String(entry.count), truncateToWidth(entry.detail, SKIP_DETAIL_WIDTH)],
    })),
    indent: "    ",
    showHeader: false,
  });
  writeLine();
}

/**
 * Discloses the cap-cut ranking whenever a cohort was actually trimmed
 * (design §16.3).
 */
function renderCohortCapDisclosure(report: PolicyEvaluationReport): void {
  const capped = new Set<PolicyRuleId>();
  for (const skip of report.skips) {
    if (skip.code === "cohort-cap-exceeded") {
      capped.add(skip.ruleId);
    }
  }
  if (capped.size === 0) {
    return;
  }
  writeLine(pc.bold("  Cohort cap"));
  writeLine("    A per-rule cap trimmed this run. Proposals are ranked by evidence strength");
  writeLine("    before the cut, which is NOT the order the rows above are displayed in.");
  for (const ruleId of POLICY_RULE_IDS) {
    if (!capped.has(ruleId)) {
      continue;
    }
    writeLine(`      ${ruleId} ranks by ${POLICY_CAP_RANKINGS[ruleId]}`);
  }
  writeLine();
}

/** The footer thresholds contributed by one resolved rule. */
function collectRuleThresholds(rule: PolicyResolvedRule): readonly (readonly [string, string])[] {
  switch (rule.kind) {
    case "rating-quality-upgrade":
      return [["minRating", String(rule.minRating)]];
    case "stale-monitoring-cleanup": {
      const entries: (readonly [string, string])[] = [["maxPlays", String(rule.maxPlays)]];
      if (rule.minDaysSinceLastViewed !== null) {
        entries.push(["minDaysSinceLastViewed", String(rule.minDaysSinceLastViewed)]);
      }
      entries.push(
        ["protectRatingAtOrAbove", String(rule.protectRatingAtOrAbove)],
        ["minTrackFileCount", String(rule.minTrackFileCount)],
      );
      return entries;
    }
    case "discovery-seed": {
      const entries: (readonly [string, string])[] = [["minRating", String(rule.minRating)]];
      if (rule.minPlays !== null) {
        entries.push(["minPlays", String(rule.minPlays)]);
      }
      entries.push(["maxSeeds", String(rule.maxSeeds)]);
      return entries;
    }
    default: {
      const exhaustive: never = rule;
      return [["kind", String(exhaustive)]];
    }
  }
}

/**
 * Renders the effective thresholds of every enabled rule on one line.
 *
 * A threshold name claimed by two enabled rules (`minRating` belongs to both
 * `rating-quality-upgrade` and `discovery-seed`) is qualified with its rule id,
 * so the line can never show two different values for one bare name.
 */
function describePolicyThresholds(report: PolicyEvaluationReport): string {
  const collected: {
    readonly ruleId: PolicyRuleId;
    readonly key: string;
    readonly value: string;
  }[] = [];
  for (const ruleId of POLICY_RULE_IDS) {
    const rule = report.policy.rules[ruleId];
    if (!rule.enabled) {
      continue;
    }
    for (const [key, value] of collectRuleThresholds(rule)) {
      collected.push({ ruleId, key, value });
    }
  }
  if (collected.length === 0) {
    return "no rule is enabled";
  }
  const claims = new Map<string, number>();
  for (const entry of collected) {
    claims.set(entry.key, (claims.get(entry.key) ?? 0) + 1);
  }
  return collected
    .map((entry) => {
      const qualified =
        (claims.get(entry.key) ?? 1) > 1 ? `${entry.ruleId}.${entry.key}` : entry.key;
      return `${qualified} ${entry.value}`;
    })
    .join(" · ");
}

/** Renders one footer block: a label gutter plus one or more value lines. */
function renderFooterBlock(label: string, lines: readonly string[]): void {
  const gutter = " ".repeat(TABLE_INDENT.length + FOOTER_LABEL_WIDTH + COLUMN_GAP);
  for (const [index, line] of lines.entries()) {
    if (index === 0) {
      writeLine(
        `${TABLE_INDENT}${padCell(label, FOOTER_LABEL_WIDTH, "left")}${" ".repeat(COLUMN_GAP)}${line}`.trimEnd(),
      );
      continue;
    }
    writeLine(`${gutter}${line}`.trimEnd());
  }
}

/** Renders slot availability, three per line, with details for the gaps. */
function renderSignals(report: PolicyEvaluationReport): void {
  const states = POLICY_SIGNALS.map(
    (signal) => `${signal} ${report.signals[signal].status === "available" ? "ok" : "unavailable"}`,
  );
  const lines: string[] = [];
  for (let index = 0; index < states.length; index += 3) {
    lines.push(states.slice(index, index + 3).join(" · "));
  }
  for (const signal of POLICY_SIGNALS) {
    const slot = report.signals[signal];
    if (slot.status === "unavailable" && slot.detail !== undefined) {
      lines.push(`└ ${signal}: ${slot.detail}`);
    }
  }
  renderFooterBlock("Signals", lines);
}

/** Renders how much data actually backed the report. */
function renderCoverage(report: PolicyEvaluationReport): void {
  const { coverage } = report;
  renderFooterBlock("Coverage", [
    `${formatCount(coverage.plexArtistsExamined)} Plex artists · ${formatCount(coverage.plexTracksExamined)} tracks · ${formatCount(coverage.totalPlaysObserved)} plays observed`,
    `${formatCount(coverage.authoritativeLinks)} authoritative links · ${formatCount(coverage.nonAuthoritativeArtists)} non-authoritative`,
    `${formatCount(coverage.ambiguousNameArtists)} ambiguous name · ${formatCount(coverage.sentinelArtistTracks)} sentinel-artist tracks · ${formatCount(coverage.unjoinedTracks)} unjoined tracks`,
  ]);
}

/** Renders the Policy / Signals / Coverage / Explain footer. */
function renderFooter(report: PolicyEvaluationReport): void {
  renderFooterBlock("Policy", [describePolicyThresholds(report)]);
  renderSignals(report);
  renderCoverage(report);
  if (report.proposals.length + report.skips.length + report.overrides.length > 0) {
    renderFooterBlock("Explain", ["rfmedia lidarr policy evaluate --explain <key>"]);
  }
}

/* ── Human render — the self-teaching layout ─────────────────────────────── */

/**
 * Whether the self-teaching layout applies.
 *
 * A run that proposed nothing and ran no rule at all teaches instead of
 * reporting: the zero-config first run is success criterion 1 of #209, and an
 * operator who has never written a `policy:` block must learn from the output
 * what the three rules are and which key enables each.
 */
function isSelfTeachingReport(report: PolicyEvaluationReport): boolean {
  return (
    report.summary.proposed === 0 && report.rules.length > 0 && report.rules.every(isSkippedRule)
  );
}

/** Why a registered rule did not run, for the self-teaching table. */
function describeSelfTeachingReason(result: PolicyRuleResult | undefined): string {
  if (result === undefined) {
    return "not reported by the engine";
  }
  if (isSkippedRule(result)) {
    return describeRuleSkip(result);
  }
  return `${result.status}: ${result.proposedCount} proposed, ${result.skippedCount} skipped`;
}

/**
 * Renders the zero-config, self-teaching rule table.
 *
 * EVERY registered rule appears with its title, its frozen
 * `POLICY_RULE_DESCRIPTORS` description, and the dotted key behind its skip —
 * that triple is the entire point of the layout, so it is driven off the
 * registry rather than off the report's rule array.
 */
function renderSelfTeachingRules(report: PolicyEvaluationReport): void {
  writeLine(`  No proposals across ${POLICY_RULE_IDS.length} rule(s).`);
  writeLine();
  const rows: PolicyTextRow[] = [];
  for (const [ruleId, result] of registeredRuleResults(report)) {
    const descriptor = POLICY_RULE_DESCRIPTORS[ruleId];
    rows.push({
      cells: [ruleId, result?.status ?? "missing", describeSelfTeachingReason(result)],
      notes: [descriptor.title, ...wrapText(descriptor.description, DESCRIPTION_WRAP_WIDTH)],
    });
  }
  renderTextTable({
    columns: [
      { title: "Rule", align: "left" },
      { title: "Status", align: "left" },
      { title: "Why", align: "left" },
    ],
    rows,
    noteColumn: 2,
  });
  writeLine();
  writeLine("  Configure rules under `policy:` in .rfmedia.yaml.");
  writeLine("  See: packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md");
  writeLine();
}

/* ── Human render — entry point ──────────────────────────────────────────── */

/**
 * Renders a complete policy evaluation to the human-output stream (stderr).
 *
 * Nothing here reaches stdout: the command owns the machine envelope and the
 * exit code, and that separation is what keeps `--output json | jq` usable.
 *
 * @param report - A completed evaluation report.
 * @param options - Whether every row is shown instead of the first
 *   {@link POLICY_HUMAN_ROW_CAP}.
 */
export function renderPolicyEvaluation(
  report: PolicyEvaluationReport,
  options: PolicyPresentationOptions,
): void {
  renderHeader(report);
  if (isSelfTeachingReport(report)) {
    renderSelfTeachingRules(report);
    renderPolicyOverrides(report, options);
    return;
  }
  writeLine(
    `  Evaluated ${formatEvaluatedAt(report.evaluatedAt)} · engine v${report.engineVersion} · status: ${colorStatus(report.status)}`,
  );
  writeLine();
  renderRuleTable(report);
  writeLine();
  renderProposals(report, options.verbose);
  renderPolicyOverrides(report, options);
  renderFollowUp(report);
  renderSkips(report, options.verbose);
  renderCohortCapDisclosure(report);
  renderFooter(report);
  writeLine();
  writeLine(
    pc.dim("  Evaluation is read-only. No plan artifact was written and nothing was changed."),
  );
  writeLine();
}

/* ── Human render — policy plan ─────────────────────────────────────────── */

/** Verbosity switch for the policy-plan human render. */
export interface PolicyPlanPresentationOptions {
  /**
   * Show every cohort change and refusal, and lift the cap on active
   * suppressions. Review-required override rows are always shown.
   */
  readonly verbose: boolean;
}

/** Explicit, color-independent outcome label for the policy-plan header. */
function policyPlanLabel(report: LidarrPolicyPlanReport): string {
  switch (report.status) {
    case "reviewed":
      return "REVIEW ONLY";
    case "no-changes":
      return "NO CHANGES";
    case "refused":
      return "REFUSED";
    case "sealed":
      return "SEALED";
    case "partial":
      return "PARTIAL";
    case "failed":
      return "FAILED";
  }
}

/** Human-readable desired state for one projected cohort. */
function describePolicyPlanCohort(cohort: PolicyPlanCohort): string {
  switch (cohort.producer) {
    case "artist-profile-assignment":
      return `quality profile id ${cohort.qualityProfileId}`;
    case "artist-monitoring":
      return cohort.monitored ? "monitored" : "unmonitored";
  }
}

/** Renders every projectable proposal, grouped by deterministic producer cohort. */
function renderPolicyPlanCohorts(
  report: LidarrPolicyPlanReport,
  options: PolicyPlanPresentationOptions,
): void {
  writeLine(pc.bold(`  Cohorts (${formatCount(report.cohorts.length)})`));
  if (report.cohorts.length === 0) {
    writeLine("    None.");
    writeLine();
    return;
  }
  for (const cohort of report.cohorts) {
    const visible = options.verbose
      ? cohort.changes
      : cohort.changes.slice(0, POLICY_HUMAN_ROW_CAP);
    const elided = visible.length < cohort.changes.length;
    writeLine(
      `    ${cohort.producer} → ${describePolicyPlanCohort(cohort)} · ${formatCount(cohort.artistIds.length)} artist(s)${elided ? ROW_CAP_HINT : ""}`,
    );
    renderTextTable({
      columns: [
        { title: "Proposal key", align: "left" },
        { title: "Artist ID", align: "right" },
        { title: "Artist", align: "left" },
        { title: "Before", align: "left" },
        { title: "After", align: "left" },
      ],
      rows: visible.map((change) => ({
        cells: [
          change.decisionKey,
          String(change.artistId),
          truncateToWidth(change.artistName, PROPOSAL_ARTIST_WIDTH),
          formatState(change.before),
          formatState(change.after),
        ],
      })),
      indent: "      ",
    });
  }
  writeLine();
}

/** Renders every expected refusal with its exact proposal key and remedy. */
function renderPolicyPlanRefusals(
  report: LidarrPolicyPlanReport,
  options: PolicyPlanPresentationOptions,
): void {
  writeLine(pc.bold(`  Refusals (${formatCount(report.refusals.length)})`));
  if (report.refusals.length === 0) {
    writeLine("    None.");
    writeLine();
    return;
  }
  const visible = options.verbose
    ? report.refusals
    : report.refusals.slice(0, POLICY_HUMAN_ROW_CAP);
  const elided = visible.length < report.refusals.length;
  if (elided) {
    writeLine(`    Showing ${visible.length} of ${report.refusals.length}${ROW_CAP_HINT}`);
  }
  renderTextTable({
    columns: [
      { title: "Proposal key", align: "left" },
      { title: "Code", align: "left" },
      { title: "Producer", align: "left" },
      { title: "Artist ID", align: "right" },
      { title: "Detail", align: "left" },
      { title: "Remedy", align: "left" },
    ],
    rows: visible.map((refusal) => ({
      cells: [
        refusal.decisionKey,
        refusal.code,
        refusal.producer,
        refusal.artistId === null ? "-" : String(refusal.artistId),
        truncateToWidth(refusal.detail, SKIP_DETAIL_WIDTH),
        refusal.remedy ?? "-",
      ],
    })),
    indent: "    ",
  });
  writeLine();
}

/** Copy-pasteable apply command with both immutable review pins and no approval flag. */
function policyPlanApplyCommand(outcome: PolicyPlanOutcome): string {
  const { plan, planPath } = outcome.generated;
  return `rfmedia lidarr apply ${quoteArgvToken(planPath)} --expected-plan-id ${quoteArgvToken(plan.id)} --expected-plan-checksum ${quoteArgvToken(plan.payloadChecksum)}`;
}

/** Renders completed artifact metadata retained by sealed and partial results. */
function renderPolicyPlanOutcomes(report: LidarrPolicyPlanReport): void {
  writeLine(pc.bold(`  Artifacts (${formatCount(report.outcomes.length)})`));
  if (report.outcomes.length === 0) {
    writeLine("    None.");
    writeLine();
    return;
  }
  for (const outcome of report.outcomes) {
    const { plan, planPath } = outcome.generated;
    writeLine(`    ${outcome.producer}`);
    writeLine(`      Proposal keys: ${outcome.decisionKeys.join(", ")}`);
    writeLine(`      File: ${planPath}`);
    writeLine(`      Plan: ${plan.id}`);
    writeLine(`      Checksum: ${plan.payloadChecksum}`);
    writeLine(pc.dim(`      ${policyPlanApplyCommand(outcome)}`));
  }
  writeLine();
}

/** Renders exact total accounting plus any typed producer failure. */
function renderPolicyPlanSummary(report: LidarrPolicyPlanReport): void {
  const { summary } = report;
  writeLine(pc.bold("  Summary"));
  writeLine(
    `    ${formatCount(summary.proposals)} proposal(s) · ${formatCount(summary.projectable)} projectable · ${formatCount(summary.refused)} refused · ${formatCount(summary.artifacts)} artifact(s)`,
  );
  if (report.failure !== undefined) {
    const producer = report.failure.producer === null ? "projection" : report.failure.producer;
    writeLine(`    Failure: ${report.failure.stage}/${producer} — ${report.failure.detail}`);
  }
  writeLine();
}

/** Renders the safe next step and exact write boundary for this rung. */
function renderPolicyPlanNext(report: LidarrPolicyPlanReport): void {
  writeLine(pc.bold("  Next"));
  if (report.mode === "recommend" && report.cohorts.length > 0 && report.refusals.length === 0) {
    writeLine("    rfmedia lidarr policy plan --mode plan");
  } else if (report.refusals.length > 0) {
    writeLine("    Resolve every refusal before sealing the selected scope.");
  } else if (report.outcomes.length > 0) {
    writeLine("    Apply each artifact separately with the pinned command shown above.");
  } else {
    writeLine("    No artifact requires follow-up.");
  }
  writeLine();
  const scope =
    report.mode === "recommend"
      ? "REVIEW ONLY: no plan artifact was written and Lidarr was not changed."
      : report.outcomes.length === 0
        ? "No plan artifact was written and Lidarr was not changed."
        : "Plan artifacts were sealed; Lidarr was not changed and nothing was applied.";
  writeLine(pc.dim(`  ${scope}`));
  writeLine();
}

/**
 * Renders a complete policy-plan review/result to stderr.
 *
 * The embedded evaluation context, deterministic cohorts, refusals, completed
 * outcomes, total accounting, and any partial failure all remain visible before
 * the command decides its exit code.
 */
export function renderPolicyPlan(
  report: LidarrPolicyPlanReport,
  options: PolicyPlanPresentationOptions,
): void {
  const { evaluation } = report;
  writeLine();
  writeLine(pc.bold(`Lidarr policy plan — ${policyPlanLabel(report)}`));
  writeLine(`  ${evaluation.plexLibrary} @ ${evaluation.plexOrigin} → ${evaluation.lidarrOrigin}`);
  writeLine(
    `  evaluated ${formatEvaluatedAt(evaluation.evaluatedAt)} · engine v${evaluation.engineVersion} · mode: ${report.mode} · status: ${report.status}`,
  );
  writeLine();
  writeLine(pc.bold("  Selection"));
  renderRuleTable(evaluation);
  writeLine();
  renderPolicyOverrides(evaluation, options);
  renderCoverage(evaluation);
  writeLine();
  renderSkips(evaluation, options.verbose);
  renderCohortCapDisclosure(evaluation);
  renderPolicyPlanCohorts(report, options);
  renderPolicyPlanRefusals(report, options);
  renderPolicyPlanOutcomes(report);
  renderPolicyPlanSummary(report);
  renderPolicyPlanNext(report);
}

/* ── Human render — `--explain` ──────────────────────────────────────────── */

/** Renders one `label value  annotation` line of the explain head block. */
function renderExplainHeadLine(label: string, value: string, annotation: string): string {
  const gutter = padCell(label, FOOTER_LABEL_WIDTH, "left");
  return `${TABLE_INDENT}${gutter} ${padCell(value, EXPLAIN_VALUE_WIDTH, "left")}${annotation}`.trimEnd();
}

/** Renders the identity-evidence block shared by both decision kinds. */
function renderExplainIdentity(identity: {
  readonly category: string;
  readonly reason: string;
}): void {
  writeLine(pc.bold("  Identity evidence"));
  writeLine(`    category ${identity.category} · reason ${identity.reason}`);
  writeLine(pc.dim(`    ${IDENTITY_RULE_SENTENCE}`));
  writeLine();
}

/** Renders one observation row's provenance cells. */
function observationCells(
  name: string,
  observation: PolicyObservation<number | boolean>,
): readonly string[] {
  if (observation.status === "unavailable") {
    return [name, "—", "", `(${observation.reason})`];
  }
  return [
    name,
    String(observation.value),
    `join ${observation.join}`,
    observation.sampleSize === undefined ? "" : `n=${observation.sampleSize} rows`,
  ];
}

/** Renders the per-signal observation block. */
function renderExplainObservations(
  observations: Readonly<Record<string, PolicyObservation<number | boolean>>>,
): void {
  const entries = Object.entries(observations);
  if (entries.length === 0) {
    return;
  }
  writeLine(pc.bold("  Observations"));
  renderTextTable({
    columns: [
      { title: "name", align: "left" },
      { title: "value", align: "left" },
      { title: "join", align: "left" },
      { title: "sample", align: "left" },
    ],
    rows: entries.map(([name, observation]) => ({ cells: observationCells(name, observation) })),
    indent: "    ",
    showHeader: false,
  });
  writeLine();
}

/**
 * Renders the threshold-check block.
 *
 * Every configured check prints its dotted `.rfmedia.yaml` path on its own line:
 * that path is what makes a verdict actionable, because the operator edits the
 * key straight off the report instead of re-deriving it from source.
 */
function renderExplainChecks(checks: readonly PolicyThresholdCheck[]): void {
  if (checks.length === 0) {
    return;
  }
  writeLine(pc.bold("  Threshold checks"));
  renderTextTable({
    columns: [
      { title: "label", align: "left" },
      { title: "comparator", align: "left" },
      { title: "bound", align: "left" },
      { title: "observed", align: "left" },
      { title: "verdict", align: "left" },
      { title: "note", align: "left" },
    ],
    rows: checks.map((check) => ({
      cells: [
        check.label,
        check.comparator,
        formatCheckValue(check.bound),
        `observed ${formatCheckValue(check.observed)}`,
        check.satisfied ? "SATISFIED" : "NOT MET",
        check.configPath === null ? "(structural gate)" : "",
      ],
      notes: check.configPath === null ? [] : [check.configPath],
    })),
    indent: "    ",
    showHeader: false,
    noteIndent: "        ",
  });
  writeLine();
}

/** Renders the causal chain behind one proposal. */
function renderProposalExplain(proposal: PolicyEvaluatedProposal, outcome = "proposed"): void {
  writeLine();
  writeLine(renderExplainHeadLine("Decision", proposal.key, `outcome: ${outcome}`));
  writeLine(
    renderExplainHeadLine(
      "Rule",
      POLICY_RULE_DESCRIPTORS[proposal.ruleId].title,
      `code: ${proposal.code}`,
    ),
  );
  writeLine(renderExplainHeadLine("Subject", formatSubject(proposal.subject), ""));
  writeLine(`  Evidence ${proposal.evidenceFingerprint}`);
  writeLine();
  renderExplainIdentity(proposal.identity);
  renderExplainObservations(proposal.observations);
  renderExplainChecks(proposal.checks);
  writeLine(pc.bold("  Proposal"));
  const artistId =
    proposal.subject.artistId === undefined ? "—" : String(proposal.subject.artistId);
  writeLine(
    `    ${proposal.handoff.producer} · artistId ${artistId} · ${formatStateTransition(proposal)}`,
  );
  writeLine();
  writeLine(pc.bold("  Follow-up (inert; nothing is executed)"));
  writeLine(pc.dim(`    ${formatHandoffCommand(proposal.handoff.argv)}`));
  writeLine();
}

/** Human explanation of one configured override and its manual recovery path. */
function renderOverrideExplain(override: PolicyOverrideResult): void {
  writeLine(pc.bold("  Override"));
  renderFooterBlock("State", [overrideStateLabel(override)]);
  renderFooterBlock("Reason", [override.reason]);
  renderFooterBlock("Expected", [override.expectedEvidenceFingerprint]);
  renderFooterBlock("Current", [override.currentEvidenceFingerprint ?? "none"]);
  renderFooterBlock("Changed", [override.staleReason ?? "none — evidence matches"]);
  renderFooterBlock("Config", [`policy.overrides[${JSON.stringify(override.key)}]`]);
  writeLine();
  writeLine(pc.bold("  Next"));
  if (override.status === "suppressed") {
    writeLine(
      "    The reviewed proposal remains withheld. Remove the override only if its reason is obsolete.",
    );
  } else if (override.status === "not-evaluated") {
    writeLine("    Rerun with the rule enabled and selected before changing the override.");
  } else if (
    override.staleReason === "evidence-changed" &&
    override.currentEvidenceFingerprint !== null
  ) {
    writeLine("    Review the current proposal evidence. If it is still intended, replace");
    writeLine("    evidenceFingerprint with Current to suppress this exact proposal revision.");
  } else if (override.staleReason === "outcome-changed") {
    writeLine("    Review the current refusal. Wait for the proposal to return, or remove the");
    writeLine("    override if the refusal proves suppression is no longer needed.");
  } else if (override.staleReason === "decision-absent") {
    writeLine("    Investigate whether the state converged or the identity changed.");
    writeLine("    Remove the override only if the record is obsolete.");
  } else {
    writeLine("    Current proposal evidence is unavailable. Rerun the evaluation before");
    writeLine("    changing or removing this override.");
  }
  writeLine();
}

/** Renders the causal chain behind one refusal. */
function renderSkipExplain(skip: PolicySkip): void {
  writeLine();
  writeLine(renderExplainHeadLine("Decision", skip.key, "outcome: skipped"));
  writeLine(
    renderExplainHeadLine("Rule", POLICY_RULE_DESCRIPTORS[skip.ruleId].title, `code: ${skip.code}`),
  );
  writeLine(renderExplainHeadLine("Subject", formatSubject(skip.subject), ""));
  writeLine();
  renderExplainIdentity(skip.identity);
  renderExplainChecks(skip.checks);
  writeLine(pc.bold("  Refusal"));
  writeLine(`    ${skip.code} — ${skip.detail}`);
  writeLine(pc.dim("    A refusal is data, not an omission. Nothing was changed."));
  writeLine();
}

/**
 * Every proposal, skip, and configured override key the report carries, in
 * first-occurrence report order.
 *
 * The command layer uses this as the candidate list when `--explain` names a key
 * that no proposal, skip, or configured override owns.
 *
 * @param report - A completed evaluation report.
 * @returns Proposal keys, then skip keys, then configured override keys,
 *   deduplicated by first occurrence.
 */
export function policyDecisionKeys(report: PolicyEvaluationReport): readonly string[] {
  return [
    ...new Set([
      ...report.proposals.map((proposal) => proposal.key),
      ...report.skips.map((skip) => skip.key),
      ...report.overrides.map((override) => override.key),
    ]),
  ];
}

/**
 * Renders one decision or configured override's full causal and recovery chain
 * to the human-output stream (stderr).
 *
 * Returns `false` and renders nothing when the key names no proposal, skip, or
 * configured override, leaving the command layer to raise its own typed lookup
 * failure — the presenter never decides an exit code and never invents an error
 * envelope.
 *
 * @param report - A completed evaluation report.
 * @param key - A key printed on a decision or configured-override row.
 * @returns True when a matching configured override, proposal, or skip was rendered.
 */
export function renderPolicyExplain(report: PolicyEvaluationReport, key: string): boolean {
  const override = report.overrides.find((candidate) => candidate.key === key);
  if (override !== undefined) {
    if (override.decision !== null) {
      if (isEvaluatedProposal(override.decision)) {
        renderProposalExplain(override.decision, "withheld proposal");
      } else {
        renderSkipExplain(override.decision);
      }
    } else {
      writeLine();
      writeLine(renderExplainHeadLine("Decision", override.key, "outcome: no current decision"));
      writeLine();
    }
    renderOverrideExplain(override);
    return true;
  }
  const proposal = report.proposals.find((candidate) => candidate.key === key);
  if (proposal !== undefined) {
    renderProposalExplain(proposal);
    return true;
  }
  const skip = report.skips.find((candidate) => candidate.key === key);
  if (skip !== undefined) {
    renderSkipExplain(skip);
    return true;
  }
  return false;
}
