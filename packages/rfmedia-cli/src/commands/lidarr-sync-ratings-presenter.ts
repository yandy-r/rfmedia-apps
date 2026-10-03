/**
 * Human rendering for `rfmedia lidarr sync-ratings` (#221).
 *
 * This module owns EVERY stderr byte the leaf emits, which is what keeps
 * `src/commands/lidarr-sync-ratings.ts` inside the command-file size budget —
 * the `lidarr-policy.ts` (388) + `./lidarr-policy-presenter.js` (1139)
 * precedent: a presenter split out of a command is deliberately exempt from the
 * ~500-line soft cap.
 *
 * Nothing that ships is re-implemented here. Override lifecycle state delegates
 * to `renderPolicyOverrides`; `--explain`, including configured-override
 * recovery, delegates to `renderPolicyExplain`; candidate-key discovery,
 * including override keys, delegates to `policyDecisionKeys`; and an applied
 * artifact delegates to `renderMutationApply`. The SEALED artifact is rendered
 * by the shipped `renderMutationPlan` from the command's `onPlanSealed`
 * callback, before any apply runs (§6.9: the path must reach the operator before
 * the next producer can fail the run), so {@link renderSyncRatings} renders apply
 * RESULTS and never re-renders a plan.
 *
 * OUTPUT BOUNDARY: nothing in this module writes to stdout. Every human line
 * goes through {@link writeLine}, which is `console.error`. stdout belongs
 * exclusively to the machine envelope the command emits through `formatOutput`,
 * and the command alone owns `process.exitCode`.
 *
 * Two provenance rules are load-bearing:
 *
 * 1. Decision state is read from `report.decisionStates` — the RAW
 *    `policy.rules.*.enabled` tri-state. `report.evaluation.policy.rules[id].enabled`
 *    is contaminated by the force-enable override the action hands the engine,
 *    so it can never be a presenter's source for state or provenance.
 * 2. A quality-profile cohort header prints the resolved profile id AND its
 *    name. `--quality-profile` resolves numerically before it resolves by name,
 *    so a profile literally named `"320"` silently resolves to whichever profile
 *    has id 320; only the pair makes that visible before `--mode apply`.
 */

import { Table } from "console-table-printer";
import pc from "picocolors";

import { truncateToWidth } from "../lib/terminal-table.js";
import { POLICY_HUMAN_ROW_CAP } from "../types/lidarr-policy.js";
import { renderMutationApply } from "./lidarr-mutation-presenter.js";
import {
  policyDecisionKeys,
  renderPolicyExplain,
  renderPolicyOverrides,
} from "./lidarr-policy-presenter.js";
import type { MutationApplyPresentationOptions } from "./lidarr-mutation-presenter.js";
import type { PolicyProducerId } from "../types/lidarr-policy.js";
import type {
  LidarrSyncRatingsMode,
  LidarrSyncRatingsOutcome,
  LidarrSyncRatingsReport,
  SyncRatingsCohort,
  SyncRatingsRefusal,
  SyncRatingsThreshold,
} from "../types/lidarr-sync-ratings.js";

/* ── Presentation constants ──────────────────────────────────────────────── */

/** Verbosity switch for the human render. */
export interface SyncRatingsPresentationOptions {
  /**
   * Show every cohort and refusal row, and lift the cap on active suppressions.
   * Review-required override rows are always shown.
   */
  readonly verbose: boolean;
}

/** Appended to any section header whose rows were elided. */
const ROW_CAP_HINT = " — rerun with --verbose to show all";

/** Per-cell display caps for the cohort and refusal tables. */
const ARTIST_WIDTH = 28;
const BECAUSE_WIDTH = 44;
const STATE_WIDTH = 24;
const DETAIL_WIDTH = 60;
const REMEDY_WIDTH = 48;

/** Deterministic thousands separators, independent of the host locale. */
const COUNT_FORMAT = new Intl.NumberFormat("en-US");

/** Decimal places on the footprint proportion. */
const FOOTPRINT_PERCENT_DIGITS = 1;

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

/* ── Scalar formatting ───────────────────────────────────────────────────── */

/** Formats a count with thousands separators. */
function formatCount(value: number): string {
  return COUNT_FORMAT.format(value);
}

/** Formats the footprint proportion as a percentage. */
function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(FOOTPRINT_PERCENT_DIGITS)}%`;
}

/**
 * Renders one side of a change's state.
 *
 * `before` and `after` carry the proposal's own string-index records, so every
 * read is bracket access narrowed with `typeof` — dot access does not compile
 * under `noPropertyAccessFromIndexSignature`, and an absent key is `undefined`
 * rather than a type error under `noUncheckedIndexedAccess`.
 *
 * @param state - The proposal's `before` or `after` map, carried verbatim.
 * @param producer - The producer that will seal this cohort.
 * @returns One operator-readable cell.
 */
function formatChangeState(
  state: Readonly<Record<string, string | number | boolean | null>>,
  producer: PolicyProducerId,
): string {
  if (producer === "artist-profile-assignment") {
    const name = state["qualityProfileName"] ?? null;
    const id = state["qualityProfileId"] ?? null;
    if (typeof name === "string") {
      return id === null ? name : `${name} (${String(id)})`;
    }
    return id === null ? "-" : `profile ${String(id)}`;
  }
  const monitored = state["monitored"] ?? null;
  if (typeof monitored !== "boolean") {
    return "-";
  }
  return monitored ? "monitored" : "unmonitored";
}

/**
 * Names where one effective threshold came from.
 *
 * `PolicyThresholdCheck.configPath` on a proposal cites the `.rfmedia.yaml` key
 * even when the effective bound arrived from a flag, so this line is the only
 * place a reviewer can tell a persistent policy from a one-off experiment.
 *
 * @param threshold - One resolved threshold.
 * @param flag - The CLI flag that overrides it.
 * @returns The provenance cell.
 */
function describeThresholdSource(threshold: SyncRatingsThreshold<unknown>, flag: string): string {
  switch (threshold.source) {
    case "flag":
      return `flag ${flag}`;
    case "config":
      return threshold.configPath === null ? "config" : `config ${threshold.configPath}`;
    case "default":
      return "default";
    default: {
      const exhaustive: never = threshold.source;
      return String(exhaustive);
    }
  }
}

/**
 * Describes what a sealable cohort would make true.
 *
 * The profile target prints its resolved id beside its name: the id is what the
 * producer binds to, and the name alone would hide a numeric-first
 * mis-resolution of `--quality-profile`.
 *
 * @param cohort - One projected cohort.
 * @returns The target clause of the cohort header.
 */
function describeCohortTarget(cohort: SyncRatingsCohort): string {
  if (cohort.producer === "artist-profile-assignment") {
    const name =
      cohort.qualityProfileName === null ? "unnamed profile" : `"${cohort.qualityProfileName}"`;
    const id = cohort.resolvedProfileId === null ? "unresolved" : String(cohort.resolvedProfileId);
    return `${name} (profile id ${id})`;
  }
  if (cohort.desiredMonitored === null) {
    return "unchanged monitoring";
  }
  return cohort.desiredMonitored ? "monitored" : "unmonitored";
}

/** Prose for a cohort that will seal nothing. */
function describeInertCohort(cohort: SyncRatingsCohort): string {
  return cohort.gate === "refused"
    ? "refused — see Refusals below"
    : "no changes — every matched artist is already converged";
}

/* ── Human render — sections ─────────────────────────────────────────────── */

/** Renders the header block: origins, library, evaluation stamp, and mode. */
function renderHeader(report: LidarrSyncRatingsReport): void {
  const { evaluation } = report;
  writeLine();
  writeLine(
    pc.bold(`Plex → Lidarr ratings sync — ${evaluation.plexLibrary} @ ${evaluation.plexOrigin}`),
  );
  writeLine(
    `  lidarr ${evaluation.lidarrOrigin} · evaluated ${evaluation.evaluatedAt} · engine v${evaluation.engineVersion} · mode: ${report.mode}`,
  );
  writeLine();
}

/** Renders the four effective thresholds with honest per-field provenance. */
function renderThresholds(report: LidarrSyncRatingsReport): void {
  const { thresholds } = report;
  const table = new Table({
    columns: [
      { name: "threshold", title: "Threshold", alignment: "left" },
      { name: "effective", title: "Effective", alignment: "left" },
      { name: "source", title: "Source", alignment: "left" },
    ],
  });
  table.addRow({
    threshold: "min stars",
    effective: `>= ${String(thresholds.minStars.value)}`,
    source: describeThresholdSource(thresholds.minStars, "--min-stars"),
  });
  table.addRow({
    threshold: "max plays",
    effective: `<= ${formatCount(thresholds.maxPlays.value)}`,
    source: describeThresholdSource(thresholds.maxPlays, "--max-plays"),
  });
  table.addRow({
    threshold: "quality profile",
    effective:
      thresholds.qualityProfile.value === null ? "unset" : `"${thresholds.qualityProfile.value}"`,
    source: describeThresholdSource(thresholds.qualityProfile, "--quality-profile"),
  });
  table.addRow({
    threshold: "max proposals",
    effective: `${formatCount(thresholds.maxProposals.value)} per decision`,
    source: describeThresholdSource(thresholds.maxProposals, "--max-proposals"),
  });
  writeLine(pc.bold("  Thresholds"));
  writeLine(table.render());
  writeLine();
}

/**
 * Renders how much data backed the report, and how much of it would change.
 *
 * The footprint is reported, never a gate: a large proportion is a prompt to
 * re-read the thresholds, not a condition this command refuses on.
 */
function renderCoverage(report: LidarrSyncRatingsReport): void {
  const { coverage } = report.evaluation;
  const { footprint } = report;
  writeLine(pc.bold("  Coverage"));
  writeLine(
    `    ${formatCount(coverage.authoritativeLinks)} authoritative links · ${formatCount(coverage.nonAuthoritativeArtists)} non-authoritative (never auto-consumed)`,
  );
  writeLine(
    `    ${formatCount(coverage.plexTracksExamined)} tracks examined · ${formatCount(coverage.totalPlaysObserved)} plays observed`,
  );
  writeLine(
    `    ${formatCount(footprint.changedArtists)} of ${formatCount(footprint.authoritativeLinks)} artists would change (${formatPercent(footprint.fraction)})`,
  );
  writeLine();
}

/**
 * Renders the per-decision verdict table.
 *
 * `State` is the RAW config tri-state off `report.decisionStates`, never the
 * engine's echoed `enabled`, which the force-enable override contaminates.
 */
function renderDecisions(report: LidarrSyncRatingsReport): void {
  const table = new Table({
    columns: [
      { name: "decision", title: "Decision", alignment: "left" },
      { name: "rule", title: "Rule", alignment: "left" },
      { name: "state", title: "State", alignment: "left" },
      { name: "gate", title: "Gate", alignment: "left" },
      { name: "changes", title: "Changes", alignment: "right" },
    ],
  });
  for (const cohort of report.cohorts) {
    table.addRow({
      decision: cohort.decision,
      rule: cohort.ruleId,
      state: report.decisionStates[cohort.decision],
      gate: cohort.gate,
      changes: cohort.changes.length,
    });
  }
  writeLine(pc.bold("  Decisions"));
  writeLine(table.render());
  writeLine();
}

/** Renders one cohort: its target, then its rows, capped unless `--verbose`. */
function renderCohort(cohort: SyncRatingsCohort, verbose: boolean): void {
  if (cohort.gate !== "sealable") {
    writeLine(pc.bold(`  ${cohort.decision} — ${describeInertCohort(cohort)}`));
    writeLine();
    return;
  }
  const visible = verbose ? cohort.changes : cohort.changes.slice(0, POLICY_HUMAN_ROW_CAP);
  const elided = visible.length < cohort.changes.length;
  writeLine(
    pc.bold(
      `  ${cohort.decision} — ${formatCount(cohort.artistIds.length)} artist(s) → ${describeCohortTarget(cohort)}${elided ? ROW_CAP_HINT : ""}`,
    ),
  );
  const table = new Table({
    columns: [
      { name: "id", title: "Artist ID", alignment: "right" },
      { name: "artist", title: "Artist", alignment: "left" },
      { name: "because", title: "Because", alignment: "left" },
      { name: "before", title: "Before", alignment: "left" },
      { name: "after", title: "After", alignment: "left" },
    ],
  });
  for (const change of visible) {
    table.addRow({
      id: change.artistId,
      artist: truncateToWidth(change.artistName, ARTIST_WIDTH),
      because: truncateToWidth(change.summary, BECAUSE_WIDTH),
      before: truncateToWidth(formatChangeState(change.before, cohort.producer), STATE_WIDTH),
      after: truncateToWidth(formatChangeState(change.after, cohort.producer), STATE_WIDTH),
    });
  }
  writeLine(table.render());
  writeLine();
}

/** The scope cell of one refusal: the decision it blocked, or the artist. */
function formatRefusalScope(refusal: SyncRatingsRefusal): string {
  if (refusal.scope === "decision") {
    return refusal.decision ?? "-";
  }
  return refusal.artistId === null ? "artist" : `artist ${String(refusal.artistId)}`;
}

/** The detail cell of one refusal, prefixed by the rule's own skip reason. */
function formatRefusalDetail(refusal: SyncRatingsRefusal): string {
  return refusal.ruleSkipReason === null
    ? refusal.detail
    : `${refusal.ruleSkipReason}: ${refusal.detail}`;
}

/**
 * Renders the refusal table.
 *
 * A refusal is DATA, never an omission: a cohort silently missing an artist is
 * indistinguishable from a bug, so each row names its cause and the exact key
 * or flag that clears it.
 */
function renderRefusals(report: LidarrSyncRatingsReport, verbose: boolean): void {
  const { refusals } = report;
  if (refusals.length === 0) {
    return;
  }
  const visible = verbose ? refusals : refusals.slice(0, POLICY_HUMAN_ROW_CAP);
  const elided = visible.length < refusals.length;
  writeLine(pc.bold(`  Refusals (${formatCount(refusals.length)})${elided ? ROW_CAP_HINT : ""}`));
  const table = new Table({
    columns: [
      { name: "code", title: "Code", alignment: "left" },
      { name: "scope", title: "Scope", alignment: "left" },
      { name: "detail", title: "Detail", alignment: "left" },
      { name: "remedy", title: "Remedy", alignment: "left" },
    ],
  });
  for (const refusal of visible) {
    table.addRow({
      code: refusal.code,
      scope: formatRefusalScope(refusal),
      detail: truncateToWidth(formatRefusalDetail(refusal), DETAIL_WIDTH),
      remedy: refusal.remedy === null ? "-" : truncateToWidth(refusal.remedy, REMEDY_WIDTH),
    });
  }
  writeLine(table.render());
  writeLine();
}

/**
 * Renders one sealed artifact that was not applied.
 *
 * The recovery command pins both `--expected-plan-id` and
 * `--expected-plan-checksum`, so an artifact swapped or regenerated between
 * seal and apply fails loudly instead of applying the wrong desired state.
 */
function renderUnappliedOutcome(outcome: LidarrSyncRatingsOutcome): void {
  const { plan, planPath } = outcome.generated;
  writeLine(`  ${outcome.decision} — sealed, not applied`);
  writeLine(pc.dim(`    rfmedia lidarr apply ${planPath} --yes \\`));
  writeLine(
    pc.dim(`      --expected-plan-id ${plan.id} --expected-plan-checksum ${plan.payloadChecksum}`),
  );
}

/**
 * Renders every sealed artifact: apply results through the shipped presenter,
 * unapplied artifacts as a copy-pasteable recovery command.
 *
 * The plan artifact itself was already rendered by `renderMutationPlan` from the
 * action's `onPlanSealed` callback, so it is deliberately not re-rendered here.
 */
function renderOutcomes(report: LidarrSyncRatingsReport, verbose: boolean): void {
  if (report.outcomes.length === 0) {
    return;
  }
  writeLine(pc.bold("  Artifacts"));
  for (const outcome of report.outcomes) {
    if (outcome.apply === undefined) {
      renderUnappliedOutcome(outcome);
      continue;
    }
    renderMutationApply(outcome.apply, mutationPresentationOptions(verbose));
  }
  writeLine();
}

/** The `--explain` key advertised in the next-steps block. */
function sampleDecisionKey(report: LidarrSyncRatingsReport): string {
  const [firstKey] = policyDecisionKeys(report.evaluation);
  return firstKey ?? "<key>";
}

/** What this run did and did not write, by rung. */
function describeWriteScope(mode: LidarrSyncRatingsMode): string {
  switch (mode) {
    case "recommend":
      return "Nothing was written. Ratings are never written back to Plex.";
    case "plan":
      return "Plan artifacts were sealed; Lidarr was not changed. Ratings are never written back to Plex.";
    case "apply":
      return "Only approved artifacts were applied. Ratings are never written back to Plex.";
    default: {
      const exhaustive: never = mode;
      return String(exhaustive);
    }
  }
}

/** Renders the next-steps block and the closing write-scope disclosure. */
function renderNextSteps(report: LidarrSyncRatingsReport): void {
  writeLine(pc.bold("  Next"));
  writeLine(`    rfmedia lidarr sync-ratings --explain ${sampleDecisionKey(report)}`);
  if (report.mode === "recommend" && report.cohorts.some((cohort) => cohort.gate === "sealable")) {
    writeLine("    rfmedia lidarr sync-ratings --mode plan");
  }
  writeLine(
    pc.dim("    rfmedia lidarr policy evaluate   (the full evaluation this report projects)"),
  );
  writeLine();
  writeLine(pc.dim(`  ${describeWriteScope(report.mode)}`));
  writeLine();
}

/* ── Human render — entry points ─────────────────────────────────────────── */

/**
 * Renders a complete sync-ratings report to the human-output stream (stderr).
 *
 * Sections, in order: header, thresholds with `flag | config | default`
 * provenance, coverage and footprint, the decision table, configured override
 * state, one block per cohort, the refusals, every sealed artifact, and the next
 * steps. Nothing reaches stdout and nothing here sets an exit code — both belong
 * to the command.
 *
 * @param report - A completed sync-ratings report.
 * @param options - Whether capped cohort, refusal, and active-suppression rows
 *   are all shown. Review-required override rows are always shown.
 * @returns Nothing; every line is written to stderr.
 */
export function renderSyncRatings(
  report: LidarrSyncRatingsReport,
  options: SyncRatingsPresentationOptions,
): void {
  renderHeader(report);
  renderThresholds(report);
  renderCoverage(report);
  renderDecisions(report);
  renderPolicyOverrides(report.evaluation, options);
  for (const cohort of report.cohorts) {
    renderCohort(cohort, options.verbose);
  }
  renderRefusals(report, options.verbose);
  renderOutcomes(report, options.verbose);
  renderNextSteps(report);
}

/**
 * Renders one decision or configured override's full causal and recovery chain,
 * delegating to the shipped `renderPolicyExplain` over the embedded evaluation
 * report.
 *
 * The projection reads only from that embedded report, so `--explain` on this
 * command and on `lidarr policy evaluate` cannot disagree about a decision.
 *
 * @param report - A completed sync-ratings report.
 * @param key - A key printed on a decision or configured-override row.
 * @returns True when a matching configured override, proposal, or skip was
 *   rendered; false leaves the command to raise its own typed lookup failure.
 */
export function renderSyncRatingsExplain(report: LidarrSyncRatingsReport, key: string): boolean {
  return renderPolicyExplain(report.evaluation, key);
}

/**
 * Every decision key `--explain` accepts, delegating to the shipped
 * `policyDecisionKeys` over the embedded evaluation report.
 *
 * The command validates `--explain` against this list in EVERY output format,
 * so `--output json --explain <typo>` fails loudly instead of emitting a full
 * envelope that silently ignored the flag.
 *
 * @param report - A completed sync-ratings report.
 * @returns Proposal keys, then skip keys, then configured override keys,
 *   deduplicated by first occurrence.
 */
export function syncRatingsDecisionKeys(report: LidarrSyncRatingsReport): readonly string[] {
  return policyDecisionKeys(report.evaluation);
}

/**
 * Builds the six-field literal `renderMutationApply` and `confirmMutationApply`
 * both require.
 *
 * A monitoring or quality-profile leaf is non-destructive, so every `allow*`
 * authorization is `false`; `plexScan` is `false` because this command never
 * writes to Plex.
 *
 * @param verbose - Whether every apply entry row is shown.
 * @returns The frozen presentation options.
 */
export function mutationPresentationOptions(verbose: boolean): MutationApplyPresentationOptions {
  return Object.freeze({
    verbose,
    allowTagReplacement: false,
    allowArtistDelete: false,
    allowAlbumDelete: false,
    allowFileDelete: false,
    plexScan: false,
  });
}
