/**
 * `rfmedia lidarr audit` leaf command factory (issue #211).
 *
 * This sibling imports NOTHING from `./lidarr.js`: the parent injects its
 * output, failure, execution-summary, and id-parsing helpers at registration
 * time, which keeps the leaf out of an ESM cycle.
 *
 * The module owns every byte of rendering for the audit. Machine formats emit
 * the `{command, result}` envelope on stdout through `formatOutput` (csv uses
 * the stable multi-row {@link LIDARR_AUDIT_CSV_COLUMNS} schema); human output
 * goes to stderr only, so `--output json | jq` stays clean.
 *
 * Audit is diagnostic by default: findings never change the exit code. The
 * `--fail-on` gate is the explicit, opt-in CI assertion, and it is applied
 * AFTER rendering so an operator always sees the report that produced it.
 * `process.exit()` is never called.
 *
 * Only `../types/lidarr-audit.js` is imported statically — it has zero value
 * imports, so the `--check` value list and the exit gate cost nothing at cold
 * start. The action itself is loaded lazily inside the handler.
 */

import { Command, Option } from "commander";
import { Table } from "console-table-printer";
import pc from "picocolors";

import { isMachineFormat, type OutputFormat } from "@rfmedia/common";

import { LookupNotFoundError, MissingRequiredArgumentError } from "../lib/errors.js";
import { truncate } from "../lib/format.js";
import {
  LIDARR_AUDIT_CHECK_IDS,
  LIDARR_AUDIT_FAIL_ON_LEVELS,
  severityRank,
  shouldFailLidarrAudit,
} from "../types/lidarr-audit.js";
import type { LidarrExecutionSuccessMetadata } from "../lib/lidarr/scheduler.js";
import type { LidarrAuditActionResult } from "../actions/lidarr/index.js";
import type {
  LidarrAuditCheckResult,
  LidarrAuditFailOn,
  LidarrAuditFinding,
  LidarrAuditRemediation,
  LidarrAuditReport,
  LidarrAuditSkipReason,
  LidarrAuditSubject,
} from "../types/lidarr-audit.js";

/** Parent-private helpers injected by commands/lidarr.ts (never imported — no cycle). */
export interface LidarrAuditCommandDeps {
  /** Reads the resolved global output format off the root command. */
  readonly resolveFormat: () => OutputFormat;
  /** Shared failure-contract renderer (sets `process.exitCode = 1`). */
  readonly reportLidarrFailure: (
    subcommand: string,
    error: unknown,
    options: {
      readonly staleHint: boolean;
      readonly format: OutputFormat;
      readonly sensitiveValues?: readonly unknown[];
    },
  ) => Promise<void>;
  /** Renders successful execution-lane metadata beneath the human report. */
  readonly renderExecutionSummary: (execution: LidarrExecutionSuccessMetadata) => void;
  /** Comma-separated unique positive-int ID parser (`label` names the kind). */
  readonly parseIdList: (label: string, value: string) => number[];
}

/** Machine success envelope. */
export interface LidarrAuditJsonOutput {
  readonly command: "lidarr-audit";
  readonly result: LidarrAuditActionResult;
}

/**
 * Stable CSV schema: one `summary` row, then one `check` row per registered
 * check, then one `finding` row per finding, sharing a flat file via `rowType`.
 * Modelled on `LIDARR_SEARCH_CSV_COLUMNS` (`./lidarr-search.js`).
 */
export const LIDARR_AUDIT_CSV_COLUMNS = [
  "command",
  "rowType",
  "report.checkedAt",
  "report.origin",
  "report.deep",
  "report.status",
  "summary.total",
  "summary.critical",
  "summary.warning",
  "summary.info",
  "summary.checksRun",
  "summary.checksSkipped",
  "summary.highestSeverity",
  "coverage.artistsExamined",
  "coverage.albumsExamined",
  "coverage.artistsScanned",
  "coverage.wantedTotal",
  "execution.lane",
  "execution.outcome",
  "execution.attempts",
  "check.id",
  "check.status",
  "check.findingCount",
  "check.skipReason",
  "check.detail",
  "finding.checkId",
  "finding.code",
  "finding.severity",
  "finding.summary",
  "finding.affected",
  "finding.subjects",
  "finding.evidence",
  "finding.remediationAction",
  "finding.remediationCommand",
  "finding.docUrl",
] as const;

/** The `skipped` arm of a per-check verdict. */
type LidarrAuditSkippedCheck = Extract<LidarrAuditCheckResult, { status: "skipped" }>;

/** Registered check ids as a membership set, for `--check` pre-flight validation. */
const AUDIT_CHECK_ID_SET: ReadonlySet<string> = new Set(LIDARR_AUDIT_CHECK_IDS);

/** Registry position per check id, used to order findings deterministically. */
const AUDIT_CHECK_ORDER: ReadonlyMap<string, number> = new Map(
  LIDARR_AUDIT_CHECK_IDS.map((id, index) => [id, index] as const),
);

/**
 * Skip reasons that are NOT a coverage gap.
 *
 * `not-selected` is the operator's own `--check` narrowing, and
 * `identity-mapping-unavailable` is the reserved `plex-alignment` skip every
 * run carries until #207/#208 ship a join key. Neither means the audit failed
 * to look at something the operator asked for, so neither forces the check
 * table. Every other reason — `requires-deep`, `plex-not-configured`,
 * `data-unavailable`, `check-error`, `not-requested` — does.
 */
const NON_GAP_SKIP_REASONS: ReadonlySet<LidarrAuditSkipReason> = new Set([
  "not-selected",
  "identity-mapping-unavailable",
]);

/** Finding rows shown in human output without `--verbose`. */
const HUMAN_FINDING_ROWS = 20;

/** Maximum deduplicated remediation entries in the follow-up block. */
const FOLLOW_UP_LIMIT = 10;

/**
 * Accumulates `--check` values without ever throwing.
 *
 * Both `--check a,b` and `--check a --check b` are accepted, and repetitions
 * combine instead of overwriting. Validation deliberately does NOT happen here:
 * a Commander `argParser` that throws is routed into `Command.error()` and
 * terminates the process, bypassing the action handler's failure contract.
 * Unknown ids — and a value that contributes no id at all, such as `--check ""`
 * from an unset CI variable — are rejected inside `.action()` instead.
 *
 * @param value - One raw `--check` occurrence, possibly comma-separated.
 * @param previous - Values accumulated from earlier occurrences.
 * @returns Every non-empty, trimmed id collected so far, in argument order.
 */
export function parseAuditCheckIds(value: string, previous?: readonly string[]): string[] {
  const parsed = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return [...(previous ?? []), ...parsed];
}

/**
 * Rejects any `--check` id that is not in the registry.
 *
 * @param ids - Raw accumulated `--check` values, or `undefined` for "all".
 * @throws {LookupNotFoundError} On the first unknown id; the available values
 *   are the full registry, which the error formatter turns into a "did you
 *   mean" hint.
 */
function assertKnownAuditCheckIds(ids: readonly string[] | undefined): void {
  if (ids === undefined) {
    return;
  }
  for (const id of ids) {
    if (!AUDIT_CHECK_ID_SET.has(id)) {
      throw new LookupNotFoundError("audit check", id, [...LIDARR_AUDIT_CHECK_IDS]);
    }
  }
}

/**
 * Orders findings critical → warning → info, then by registry check order.
 *
 * @param findings - The report's findings.
 * @returns A new ordered array; the input is never mutated (it is frozen).
 */
function sortAuditFindings(findings: readonly LidarrAuditFinding[]): readonly LidarrAuditFinding[] {
  const fallback = LIDARR_AUDIT_CHECK_IDS.length;
  return [...findings].sort((left, right) => {
    const bySeverity = severityRank(right.severity) - severityRank(left.severity);
    if (bySeverity !== 0) {
      return bySeverity;
    }
    return (
      (AUDIT_CHECK_ORDER.get(left.checkId) ?? fallback) -
      (AUDIT_CHECK_ORDER.get(right.checkId) ?? fallback)
    );
  });
}

/**
 * Renders one finding subject as a single operator-readable label.
 *
 * @param subject - The subject to label.
 * @returns The label, e.g. `artist #42 Aphex Twin`.
 */
function formatAuditSubject(subject: LidarrAuditSubject): string {
  switch (subject.kind) {
    case "instance":
      return `instance ${subject.origin}`;
    case "artist":
      return `artist #${subject.artistId} ${subject.name}`;
    case "album":
      return `album #${subject.albumId} ${subject.title} (artist #${subject.ownerArtistId} ${subject.ownerArtistName})`;
    case "queue":
      return `queue ${subject.scope}`;
    case "media-server":
      return subject.library === undefined
        ? "media-server"
        : `media-server library ${subject.library}`;
    default: {
      const exhaustive: never = subject;
      return String(exhaustive);
    }
  }
}

/** Narrows a per-check verdict to its `skipped` arm. */
function isSkippedCheck(check: LidarrAuditCheckResult): check is LidarrAuditSkippedCheck {
  return check.status === "skipped";
}

/** Projects the audit report into the flat multi-row CSV records. */
function projectAuditCsv(result: LidarrAuditActionResult): readonly Record<string, unknown>[] {
  const { execution, report } = result;
  const summary: Record<string, unknown> = {
    command: "lidarr-audit",
    rowType: "summary",
    "report.checkedAt": report.checkedAt,
    "report.origin": report.origin,
    "report.deep": report.deep,
    "report.status": report.status,
    "summary.total": report.summary.total,
    "summary.critical": report.summary.critical,
    "summary.warning": report.summary.warning,
    "summary.info": report.summary.info,
    "summary.checksRun": report.summary.checksRun,
    "summary.checksSkipped": report.summary.checksSkipped,
    "summary.highestSeverity": report.summary.highestSeverity,
    "coverage.artistsExamined": report.coverage.artistsExamined,
    "coverage.albumsExamined": report.coverage.albumsExamined,
    "coverage.artistsScanned": report.coverage.artistsScanned,
    "coverage.wantedTotal": report.coverage.wantedTotal,
    "execution.lane": execution.lane,
    "execution.outcome": execution.outcome,
    "execution.attempts": execution.attempts,
  };
  return [
    summary,
    ...report.checks.map((check) => ({
      command: "lidarr-audit",
      rowType: "check",
      "check.id": check.id,
      "check.status": check.status,
      "check.findingCount": check.findingCount,
      "check.skipReason": isSkippedCheck(check) ? check.skipReason : undefined,
      "check.detail": isSkippedCheck(check) ? check.detail : undefined,
    })),
    ...report.findings.map((finding) => ({
      command: "lidarr-audit",
      rowType: "finding",
      "finding.checkId": finding.checkId,
      "finding.code": finding.code,
      "finding.severity": finding.severity,
      "finding.summary": finding.summary,
      "finding.affected": finding.affected,
      "finding.subjects": JSON.stringify(finding.subjects),
      "finding.evidence": JSON.stringify(finding.evidence),
      "finding.remediationAction": finding.remediation.action,
      "finding.remediationCommand": finding.remediation.command,
      "finding.docUrl": finding.remediation.docUrl,
    })),
  ];
}

/** Renders the origin/depth/coverage header block to stderr. */
function renderAuditHeader(report: LidarrAuditReport): void {
  const { coverage } = report;
  const wanted = coverage.wantedTotal === null ? "not sampled" : String(coverage.wantedTotal);
  console.error("");
  console.error(pc.bold("Lidarr Library Audit"));
  console.error("");
  console.error(
    `  Origin: ${report.origin} · Depth: ${report.deep ? "deep" : "library"} · ${report.checkedAt}`,
  );
  console.error(
    `  Coverage: ${coverage.artistsExamined} artist(s) · ${coverage.albumsExamined} album(s) · ` +
      `wanted backlog ${wanted}`,
  );
  console.error("");
}

/**
 * Renders the per-check verdict table.
 *
 * Every registered check is listed so a skip is never silent; the caller
 * suppresses the table only on the quiet-when-clean path.
 */
function renderAuditChecks(report: LidarrAuditReport): void {
  const table = new Table({
    columns: [
      { name: "check", title: "Check", alignment: "left" },
      { name: "status", title: "Status", alignment: "left" },
      { name: "findings", title: "Findings", alignment: "right" },
      { name: "note", title: "Note", alignment: "left" },
    ],
  });
  for (const check of report.checks) {
    table.addRow({
      check: check.id,
      status: check.status,
      findings: check.findingCount,
      note: isSkippedCheck(check) ? truncate(`${check.skipReason}: ${check.detail}`, 60) : "-",
    });
  }
  console.error(table.render());
  console.error("");
}

/** Renders the ordered findings table, plus every subject under `--verbose`. */
function renderAuditFindings(findings: readonly LidarrAuditFinding[], verbose: boolean): void {
  if (findings.length === 0) {
    console.error(pc.green("  No findings."));
    console.error("");
    return;
  }

  const visible = verbose ? findings : findings.slice(0, HUMAN_FINDING_ROWS);
  const table = new Table({
    columns: [
      { name: "severity", title: "Severity", alignment: "left" },
      { name: "check", title: "Check", alignment: "left" },
      { name: "affected", title: "Affected", alignment: "right" },
      { name: "summary", title: "Summary", alignment: "left" },
    ],
  });
  for (const finding of visible) {
    table.addRow({
      severity: finding.severity,
      check: finding.checkId,
      affected: finding.affected,
      summary: truncate(finding.summary, 64),
    });
  }
  console.error(table.render());

  if (visible.length < findings.length) {
    console.error(
      pc.dim(
        `  Showing ${visible.length} of ${findings.length}; rerun with --verbose to show all.`,
      ),
    );
  }
  if (verbose) {
    for (const finding of findings) {
      const subjects = finding.subjects.map(formatAuditSubject).join(", ");
      console.error(
        pc.dim(`  ${finding.code}: ${subjects === "" ? "no subjects recorded" : subjects}`),
      );
    }
  }
  console.error("");
}

/**
 * Renders the deduplicated, capped `Suggested follow-up` block.
 *
 * Deduplication is keyed on the remediation command AND its action prose. Many
 * remediations share one read command — `rfmedia lidarr health` alone backs five
 * finding codes — while `action` is the only part this block prints, so keying
 * on the command alone would silently drop distinct advice.
 */
function renderAuditFollowUp(findings: readonly LidarrAuditFinding[]): void {
  const seen = new Set<string>();
  const remediations: LidarrAuditRemediation[] = [];
  for (const { remediation } of findings) {
    // The pair is JSON-encoded so the boundary between the two fields stays
    // unambiguous for any command or action text.
    const key = JSON.stringify([remediation.command, remediation.action]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    remediations.push(remediation);
  }
  if (remediations.length === 0) {
    return;
  }

  console.error(pc.bold("  Suggested follow-up"));
  for (const remediation of remediations.slice(0, FOLLOW_UP_LIMIT)) {
    console.error(`    - ${remediation.action}`);
    if (remediation.command !== undefined) {
      console.error(pc.dim(`      $ ${remediation.command}`));
    }
    if (remediation.docUrl !== undefined) {
      console.error(pc.dim(`      ${remediation.docUrl}`));
    }
  }
  if (remediations.length > FOLLOW_UP_LIMIT) {
    console.error(pc.dim(`    … and ${remediations.length - FOLLOW_UP_LIMIT} more`));
  }
  console.error("");
}

/**
 * Renders one yellow line per check that could not be evaluated.
 *
 * Only `data-unavailable` and `check-error` appear here: every other skip
 * reason is an expected absence and never degrades the report.
 */
function renderAuditDegradation(skipped: readonly LidarrAuditSkippedCheck[]): void {
  const degraded = skipped.filter(
    (check) => check.skipReason === "data-unavailable" || check.skipReason === "check-error",
  );
  for (const check of degraded) {
    console.error(pc.yellow(`  Degraded: ${check.title} — ${check.skipReason}: ${check.detail}`));
  }
  if (degraded.length > 0) {
    console.error("");
  }
}

/** Renders the CI gate verdict; silent unless `--fail-on` was set. */
function renderAuditGate(
  report: LidarrAuditReport,
  failOn: LidarrAuditFailOn,
  gated: boolean,
): void {
  if (failOn === "none") {
    return;
  }
  console.error(
    `  Audit gate: ${gated ? pc.red("FAILED") : pc.green("PASSED")} ` +
      `(--fail-on ${failOn}; highest severity ${report.summary.highestSeverity})`,
  );
  console.error("");
}

/**
 * Renders the complete human report to stderr.
 *
 * Quiet when clean: a report with no findings whose only skips are the
 * operator's own `--check` narrowing and the reserved `plex-alignment` skip
 * prints just the header and a single green line, so a healthy audit stays
 * scannable. Any other skip is a coverage gap ({@link NON_GAP_SKIP_REASONS}),
 * so the full check table is rendered instead — the reserved check alone must
 * not suppress the quiet path, since every run carries it.
 *
 * @param report - The audit report.
 * @param verbose - Whether every finding and subject should be shown.
 */
function renderAuditReport(report: LidarrAuditReport, verbose: boolean): void {
  renderAuditHeader(report);

  const skipped = report.checks.filter(isSkippedCheck);
  const coverageGaps = skipped.filter((check) => !NON_GAP_SKIP_REASONS.has(check.skipReason));
  if (report.status === "clean" && coverageGaps.length === 0) {
    console.error(pc.green(`  No findings across ${report.summary.checksRun} check(s).`));
    console.error("");
    return;
  }

  renderAuditChecks(report);
  const ordered = sortAuditFindings(report.findings);
  renderAuditFindings(ordered, verbose);
  renderAuditFollowUp(ordered);
  renderAuditDegradation(skipped);
  if (skipped.some((check) => check.skipReason === "requires-deep")) {
    console.error(pc.dim("  Run with --deep for album-level checks."));
    console.error("");
  }
}

/**
 * Builds the read-only `audit` leaf command.
 *
 * All three pre-flight validations (`--artist-ids` without `--deep`, an empty
 * `--check` selection, an unknown `--check` id) run inside the action handler's
 * `try`, so a rejected invocation produces the same failure envelope (and exit
 * code 1) as any other Lidarr failure instead of a bare Commander abort.
 *
 * @param deps - Helpers injected by commands/lidarr.ts at registration time.
 * @returns The configured Commander leaf, ready for `addCommand`.
 */
export function createLidarrAuditCommand(deps: LidarrAuditCommandDeps): Command {
  return new Command("audit")
    .description("Audit Lidarr library health and drift")
    .addOption(
      new Option("--check <ids>", "Run only these checks (repeatable, comma-separated)")
        .argParser(parseAuditCheckIds)
        .helpGroup("Selection:"),
    )
    .addOption(
      new Option("--deep", "Include per-artist album scan (1 + N requests)").helpGroup(
        "Selection:",
      ),
    )
    .addOption(
      new Option("--artist-ids <ids>", "Restrict the deep album scan to these artist IDs")
        .argParser((value: string) => deps.parseIdList("Artist", value))
        .helpGroup("Selection:"),
    )
    .addOption(
      new Option("--fail-on <level>", "Exit 1 when findings reach this severity")
        .choices(LIDARR_AUDIT_FAIL_ON_LEVELS)
        .default("none")
        .helpGroup("Safety:"),
    )
    .addOption(
      new Option("-v, --verbose", "Show every finding subject in human output").helpGroup(
        "Output:",
      ),
    )
    .addOption(new Option("--lidarr-url <url>", "Lidarr server URL").helpGroup("Connection:"))
    .addOption(new Option("--lidarr-api-key <key>", "Lidarr API key").helpGroup("Connection:"))
    .addOption(new Option("--plex-url <url>", "Plex server URL").helpGroup("Connection:"))
    .addOption(new Option("--plex-token <token>", "Plex API token").helpGroup("Connection:"))
    .action(async (cmdOptions: Record<string, unknown>) => {
      const format = deps.resolveFormat();
      try {
        // Validate BEFORE the lazy action import so malformed input never
        // initializes the client, the tracking database, or the Plex adapter.
        const deep = cmdOptions["deep"] === true;
        const artistIds = cmdOptions["artistIds"] as number[] | undefined;
        if (artistIds !== undefined && !deep) {
          throw new MissingRequiredArgumentError("--artist-ids requires --deep", "lidarr audit");
        }
        const check = cmdOptions["check"] as readonly string[] | undefined;
        // `--check ""` (an unset CI variable), `--check ","` and `--check " "`
        // all parse to zero ids. The engine takes an empty selection literally,
        // so without this guard the run would report every check `not-selected`,
        // finish `clean`, and pass any `--fail-on` gate having evaluated nothing.
        if (check !== undefined && check.length === 0) {
          throw new MissingRequiredArgumentError(
            "--check requires at least one audit check id",
            "lidarr audit",
          );
        }
        assertKnownAuditCheckIds(check);
        const failOn = (cmdOptions["failOn"] as LidarrAuditFailOn | undefined) ?? "none";

        const { executeLidarrAudit } = await import("../actions/lidarr/index.js");
        const result = await executeLidarrAudit({
          check,
          deep,
          artistIds,
          lidarrUrl: cmdOptions["lidarrUrl"] as string | undefined,
          lidarrApiKey: cmdOptions["lidarrApiKey"] as string | undefined,
          plexUrl: cmdOptions["plexUrl"] as string | undefined,
          plexToken: cmdOptions["plexToken"] as string | undefined,
        });

        const gated = shouldFailLidarrAudit(result.report, failOn);
        if (isMachineFormat(format)) {
          const { formatOutput } = await import("../lib/formatters/index.js");
          if (format === "csv") {
            await formatOutput(format, projectAuditCsv(result), {
              columns: [...LIDARR_AUDIT_CSV_COLUMNS],
            });
          } else {
            const jsonOutput: LidarrAuditJsonOutput = { command: "lidarr-audit", result };
            await formatOutput(format, jsonOutput);
          }
        } else {
          renderAuditReport(result.report, cmdOptions["verbose"] === true);
          renderAuditGate(result.report, failOn, gated);
          deps.renderExecutionSummary(result.execution);
        }

        // The gate is applied only after the report has been rendered, so an
        // operator always sees the evidence behind a failing CI run.
        if (gated) {
          process.exitCode = 1;
        }
      } catch (error) {
        await deps.reportLidarrFailure("audit", error, {
          staleHint: false,
          format,
          sensitiveValues: [cmdOptions["lidarrApiKey"], cmdOptions["plexToken"]],
        });
      }
    });
}
