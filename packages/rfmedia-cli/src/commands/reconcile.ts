/**
 * Top-level metadata reconciliation command and stable result presenters.
 *
 * Cheap CLI validation happens before the action module is loaded. Actions
 * remain output-agnostic; this module owns stdout/stderr separation and exit
 * status propagation.
 */

import { isAbsolute } from "node:path";

import { getOutputFormat, isMachineFormat, type OutputFormat } from "@rfmedia/common";
import { Command, InvalidArgumentError, Option } from "commander";
import pc from "picocolors";

import type { ReconciliationActionOptions } from "../actions/reconcile.js";
import { MissingRequiredArgumentError, OptionConflictError } from "../lib/errors.js";
import { redactErrorMessage } from "../lib/redact-error-message.js";
import { getGlobalSignal } from "../lib/signal-handler.js";
import type {
  ReconciliationBlocker,
  ReconciliationFinding,
  ReconciliationResult,
  ReconciliationStrategy,
  ReconciliationTargetOutcome,
  ReconciliationValue,
} from "../types/reconciliation.js";

const COMMAND_ID = "reconcile";
const WINNER_FLAGS = ["fileWins", "dbWins", "serverWins"] as const;
const HUMAN_DETAIL_ROWS = 20;

interface ReconcileActions {
  readonly executeReconciliation: (
    options: ReconciliationActionOptions,
  ) => Promise<ReconciliationResult>;
}

/** Injectable command dependencies used by focused tests and embeddings. */
export interface ReconcileCommandDependencies {
  /** Resolves the root `--json`/`--output` decision after the pre-action hook. */
  readonly resolveFormat: () => OutputFormat;
  /** Test seam; production uses the repository-owned process signal. */
  readonly resolveSignal?: () => AbortSignal;
  /** Test seam; production retains a lazy action-module import. */
  readonly loadActions?: () => Promise<ReconcileActions>;
}

/** Stable JSON/YAML success envelope. */
export interface ReconcileMachineOutput {
  readonly command: typeof COMMAND_ID;
  readonly result: ReconciliationResult;
}

/** Fixed CSV schema shared by summary, finding, and outcome rows. */
export const RECONCILE_CSV_COLUMNS = [
  "command",
  "rowKind",
  "schema",
  "status",
  "success",
  "exitCode",
  "mode",
  "strategy",
  "sourceRoot",
  "library",
  "databasePath",
  "operationId",
  "executed",
  "executable",
  "allowPartial",
  "counts.paths",
  "counts.findings",
  "counts.inSync",
  "counts.observedResiduals",
  "counts.blockers",
  "counts.ratingOutcomes.total",
  "counts.ratingOutcomes.planned",
  "counts.ratingOutcomes.applied",
  "counts.ratingOutcomes.skipped",
  "counts.ratingOutcomes.unsupported",
  "counts.ratingOutcomes.failed",
  "counts.databaseStatOutcomes.total",
  "counts.databaseStatOutcomes.planned",
  "counts.databaseStatOutcomes.applied",
  "counts.databaseStatOutcomes.skipped",
  "counts.databaseStatOutcomes.failed",
  "summary.failureCodes",
  "summary.blockers",
  "postApply.status",
  "postApply.checkedPaths",
  "postApply.requestedRatingDrift",
  "postApply.pendingDatabaseStatRefreshes",
  "finding.path",
  "finding.field",
  "finding.code",
  "finding.repairable",
  "finding.observedResidual",
  "finding.evidence",
  "finding.operationIds",
  "finding.serverTrackIds",
  "outcome.kind",
  "outcome.path",
  "outcome.target",
  "outcome.inventoryRowId",
  "outcome.status",
  "outcome.code",
  "outcome.before",
  "outcome.intended",
] as const;

type RawCommandOptions = Record<string, unknown>;

function parsePositiveInteger(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new InvalidArgumentError("Value must be a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Value must be a positive integer");
  }
  return parsed;
}

function optionalPositiveInteger(options: RawCommandOptions, key: string): number | undefined {
  const value = options[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new InvalidArgumentError("Value must be a positive integer");
  }
  return parsePositiveInteger(value);
}

function optionalNonEmptyString(
  options: RawCommandOptions,
  key: string,
  flag: string,
): string | undefined {
  const value = options[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new MissingRequiredArgumentError(`${flag} requires a non-empty value`, COMMAND_ID);
  }
  return value;
}

function parseSourcePath(sourcePath: string): string {
  if (sourcePath.trim() === "") {
    throw new InvalidArgumentError("Source path must be non-empty");
  }
  if (!isAbsolute(sourcePath)) {
    throw new InvalidArgumentError("Source path must be absolute");
  }
  return sourcePath;
}

function resolveStrategy(options: RawCommandOptions): ReconciliationStrategy {
  const selected = WINNER_FLAGS.filter((flag) => options[flag] === true);
  if (selected.length === 0) {
    throw new MissingRequiredArgumentError(
      "exactly one of --file-wins, --db-wins, or --server-wins is required",
      "reconcile apply",
    );
  }
  if (selected.length > 1) {
    throw new OptionConflictError(
      `--${selected[0]!.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`,
      "another winner flag",
      "select exactly one of --file-wins, --db-wins, or --server-wins",
    );
  }
  const winner = selected[0]!;
  switch (winner) {
    case "fileWins":
      return "file-wins";
    case "dbWins":
      return "db-wins";
    case "serverWins":
      return "server-wins";
  }
}

function strategyFlags(strategy: ReconciliationStrategy): {
  readonly fileWins: boolean;
  readonly dbWins: boolean;
  readonly serverWins: boolean;
} {
  return {
    fileWins: strategy === "file-wins",
    dbWins: strategy === "db-wins",
    serverWins: strategy === "server-wins",
  };
}

function commonCsvFields(result: ReconciliationResult): Record<string, unknown> {
  return {
    command: COMMAND_ID,
    schema: result.schema,
    status: result.status,
    success: result.success,
    exitCode: result.exitCode,
    mode: result.mode,
    strategy: result.strategy,
    sourceRoot: result.sourceRoot,
    library: result.library,
    databasePath: result.databasePath,
    operationId: result.operationId,
    executed: result.executed,
    executable: result.executable,
    allowPartial: result.allowPartial,
    "counts.paths": result.counts.paths,
    "counts.findings": result.counts.findings,
    "counts.inSync": result.counts.inSync,
    "counts.observedResiduals": result.counts.observedResiduals,
    "counts.blockers": result.counts.blockers,
    "counts.ratingOutcomes.total": result.counts.ratingOutcomes.total,
    "counts.ratingOutcomes.planned": result.counts.ratingOutcomes.planned,
    "counts.ratingOutcomes.applied": result.counts.ratingOutcomes.applied,
    "counts.ratingOutcomes.skipped": result.counts.ratingOutcomes.skipped,
    "counts.ratingOutcomes.unsupported": result.counts.ratingOutcomes.unsupported,
    "counts.ratingOutcomes.failed": result.counts.ratingOutcomes.failed,
    "counts.databaseStatOutcomes.total": result.counts.databaseStatOutcomes.total,
    "counts.databaseStatOutcomes.planned": result.counts.databaseStatOutcomes.planned,
    "counts.databaseStatOutcomes.applied": result.counts.databaseStatOutcomes.applied,
    "counts.databaseStatOutcomes.skipped": result.counts.databaseStatOutcomes.skipped,
    "counts.databaseStatOutcomes.failed": result.counts.databaseStatOutcomes.failed,
    "summary.failureCodes": JSON.stringify(result.failureCodes),
    "summary.blockers": JSON.stringify(result.blockers),
    "postApply.status": result.postApply?.status,
    "postApply.checkedPaths": result.postApply?.checkedPaths,
    "postApply.requestedRatingDrift": result.postApply?.requestedRatingDrift,
    "postApply.pendingDatabaseStatRefreshes": result.postApply?.pendingDatabaseStatRefreshes,
  };
}

function findingCsvFields(
  finding: ReconciliationFinding,
  observedResidual: boolean,
): Record<string, unknown> {
  return {
    "finding.path": finding.path,
    "finding.field": finding.field,
    "finding.code": finding.code,
    "finding.repairable": finding.repairable,
    "finding.observedResidual": observedResidual,
    "finding.evidence": JSON.stringify(finding.evidence),
    "finding.operationIds": JSON.stringify(finding.operationIds),
    "finding.serverTrackIds": JSON.stringify(finding.serverTrackIds),
  };
}

function outcomeCsvFields(outcome: ReconciliationTargetOutcome): Record<string, unknown> {
  return {
    "outcome.kind": outcome.kind,
    "outcome.path": outcome.path,
    "outcome.target": outcome.target,
    "outcome.inventoryRowId": outcome.kind === "database-stat" ? outcome.inventoryRowId : undefined,
    "outcome.status": outcome.status,
    "outcome.code": outcome.code,
    "outcome.before": JSON.stringify(outcome.before),
    "outcome.intended": JSON.stringify(outcome.intended),
  };
}

function findingIdentity(finding: ReconciliationFinding): string {
  return JSON.stringify([
    finding.path,
    finding.field,
    finding.code,
    finding.evidence,
    finding.operationIds,
    finding.serverTrackIds,
  ]);
}

function projectCsv(result: ReconciliationResult): readonly Record<string, unknown>[] {
  const common = commonCsvFields(result);
  const residuals = new Set(result.observedResiduals.map(findingIdentity));
  return Object.freeze([
    { ...common, rowKind: "summary" },
    ...result.findings.map((finding) => ({
      ...common,
      rowKind: "finding",
      ...findingCsvFields(finding, residuals.has(findingIdentity(finding))),
    })),
    ...result.outcomes.map((outcome) => ({
      ...common,
      rowKind: "outcome",
      ...outcomeCsvFields(outcome),
    })),
  ]);
}

function evidenceText(evidence: readonly ReconciliationValue[]): string {
  return evidence
    .map((value) => {
      const projected =
        value.value === null ? "" : `=${terminalSafeText(JSON.stringify(value.value))}`;
      return `${terminalSafeText(value.plane)}:${terminalSafeText(value.state)}${projected}`;
    })
    .join(", ");
}

function terminalSafeText(value: unknown): string {
  return redactErrorMessage(String(value));
}

function renderFinding(finding: ReconciliationFinding): string {
  const field = finding.field === null ? "path" : terminalSafeText(finding.field);
  return `${terminalSafeText(finding.path)} · ${field}/${terminalSafeText(finding.code)} · ${evidenceText(finding.evidence)}`;
}

function renderOutcome(outcome: ReconciliationTargetOutcome): string {
  const target =
    outcome.kind === "database-stat"
      ? `database row ${outcome.inventoryRowId}`
      : terminalSafeText(outcome.target);
  return `${terminalSafeText(outcome.path)} · ${terminalSafeText(outcome.kind)}/${target} · ${terminalSafeText(outcome.status)} (${terminalSafeText(outcome.code)})`;
}

function renderBlocker(blocker: ReconciliationBlocker): string {
  const target = blocker.target === null ? "" : ` → ${terminalSafeText(blocker.target)}`;
  return `${terminalSafeText(blocker.path)} · ${terminalSafeText(blocker.operation)}${target} · ${terminalSafeText(blocker.code)}`;
}

function renderSection(
  title: string,
  rows: readonly string[],
  detailLimit = HUMAN_DETAIL_ROWS,
): void {
  console.error(pc.bold(`  ${title} (${rows.length})`));
  const visible = rows.slice(0, detailLimit);
  if (visible.length === 0) {
    console.error("    None");
  } else {
    for (const row of visible) console.error(`    - ${row}`);
  }
  if (visible.length < rows.length) {
    console.error(pc.dim(`    Showing ${visible.length} of ${rows.length}.`));
  }
  console.error("");
}

function renderHuman(result: ReconciliationResult): void {
  const { counts } = result;
  console.error("");
  console.error(pc.bold("Metadata Reconciliation"));
  console.error("");
  console.error(
    `  ${terminalSafeText(result.mode)}/${terminalSafeText(result.status)} · ${result.success ? "successful" : "incomplete"} · exit ${result.exitCode}`,
  );
  console.error(`  Source: ${terminalSafeText(result.sourceRoot)}`);
  console.error(
    `  Library: ${terminalSafeText(result.library)} · Database: ${terminalSafeText(result.databasePath)}`,
  );
  console.error(
    `  Strategy: ${terminalSafeText(result.strategy ?? "none")} · Executed: ${String(result.executed)} · Executable: ${String(result.executable)}`,
  );
  console.error(
    `  Summary: ${counts.paths} path(s) · ${counts.findings} finding(s) · ` +
      `${counts.inSync} in sync · ${counts.observedResiduals} observed residual(s) · ` +
      `${counts.blockers} blocker(s)`,
  );
  console.error(
    `  Rating outcomes: ${counts.ratingOutcomes.planned} planned · ` +
      `${counts.ratingOutcomes.applied} applied · ${counts.ratingOutcomes.skipped} skipped · ` +
      `${counts.ratingOutcomes.unsupported} unsupported · ${counts.ratingOutcomes.failed} failed`,
  );
  console.error(
    `  Database stat outcomes: ${counts.databaseStatOutcomes.planned} planned · ` +
      `${counts.databaseStatOutcomes.applied} applied · ` +
      `${counts.databaseStatOutcomes.skipped} skipped · ${counts.databaseStatOutcomes.failed} failed`,
  );
  console.error("");

  renderSection("Findings", result.findings.map(renderFinding));
  renderSection("Blockers", result.blockers.map(renderBlocker));
  renderSection("Target outcomes", result.outcomes.map(renderOutcome));

  if (result.postApply !== null) {
    console.error(
      `  Verification: ${terminalSafeText(result.postApply.status)} · ${result.postApply.checkedPaths} path(s) checked · ` +
        `${result.postApply.requestedRatingDrift} rating drift · ` +
        `${result.postApply.pendingDatabaseStatRefreshes} pending stat refresh(es)`,
    );
    console.error("");
  }
}

async function emitResult(format: OutputFormat, result: ReconciliationResult): Promise<void> {
  const projectedResult =
    result.status === "cancelled" && process.exitCode === 143 && result.exitCode !== 143
      ? { ...result, exitCode: 143 as const }
      : result;
  if (isMachineFormat(format)) {
    const { formatOutput } = await import("../lib/formatters/index.js");
    if (format === "csv") {
      await formatOutput(format, projectCsv(projectedResult), {
        columns: [...RECONCILE_CSV_COLUMNS],
      });
    } else {
      const output: ReconcileMachineOutput = { command: COMMAND_ID, result: projectedResult };
      await formatOutput(format, output);
    }
  } else {
    renderHuman(projectedResult);
  }
  setCommandExitCode(projectedResult.exitCode);
}

function setCommandExitCode(exitCode: number): void {
  if (process.exitCode === 130 || process.exitCode === 143) return;
  process.exitCode = exitCode;
}

async function reportFailure(
  format: OutputFormat,
  error: unknown,
  sensitiveValues: readonly unknown[],
): Promise<void> {
  const message = redactErrorMessage(error, sensitiveValues);
  const signalExitCode =
    process.exitCode === 130 || process.exitCode === 143 ? process.exitCode : undefined;
  const exitCode =
    signalExitCode ?? (error instanceof Error && error.name === "AbortError" ? 130 : 1);
  if (isMachineFormat(format)) {
    const { formatOutput } = await import("../lib/formatters/index.js");
    await formatOutput(format, {
      command: COMMAND_ID,
      error: {
        message,
        exitCode,
      },
    });
  } else {
    console.error(pc.red(`Reconciliation failed: ${message}`));
  }
  setCommandExitCode(exitCode);
}

function addScanOptions(command: Command): Command {
  return command
    .argument("<source-path>", "Absolute local music-library root")
    .addOption(new Option("--library <name>", "Media-server music library"))
    .addOption(new Option("--tracking-database <path>", "Existing rfmedia tracking database"))
    .addOption(new Option("--operation-id <positive-integer>", "Inventory operation generation"))
    .addOption(new Option("--workers <positive-integer>", "Maximum concurrent metadata readers"))
    .addOption(new Option("--no-progress", "Disable progress rendering"));
}

function sharedActionOptions(
  sourcePath: string,
  options: RawCommandOptions,
  format: OutputFormat,
): {
  readonly sourcePath: string;
  readonly library?: string;
  readonly trackingDatabase?: string;
  readonly operationId?: number;
  readonly workers?: number;
  readonly progress: boolean;
} {
  return {
    sourcePath: parseSourcePath(sourcePath),
    library: optionalNonEmptyString(options, "library", "--library"),
    trackingDatabase: optionalNonEmptyString(options, "trackingDatabase", "--tracking-database"),
    operationId: optionalPositiveInteger(options, "operationId"),
    workers: optionalPositiveInteger(options, "workers"),
    progress: options["progress"] !== false && !isMachineFormat(format),
  };
}

/** Builds the top-level `rfmedia reconcile scan|apply` command tree. */
export function createReconcileCommand(deps: ReconcileCommandDependencies): Command {
  const loadActions =
    deps.loadActions ?? ((): Promise<ReconcileActions> => import("../actions/reconcile.js"));
  const resolveSignal = deps.resolveSignal ?? getGlobalSignal;
  const command = new Command(COMMAND_ID).description(
    "Detect and reconcile metadata drift across files, inventory, and media server",
  );

  const scan = addScanOptions(
    new Command("scan").description("Scan metadata drift without modifying any source"),
  ).action(async (sourcePath: string, options: RawCommandOptions) => {
    const format = deps.resolveFormat();
    try {
      const actionOptions: ReconciliationActionOptions = {
        mode: "scan",
        ...sharedActionOptions(sourcePath, options, format),
        signal: resolveSignal(),
      };
      const { executeReconciliation } = await loadActions();
      await emitResult(format, await executeReconciliation(actionOptions));
    } catch (error: unknown) {
      await reportFailure(format, error, []);
    }
  });
  command.addCommand(scan);

  const apply = addScanOptions(
    new Command("apply").description(
      "Preview or execute an explicitly selected reconciliation strategy",
    ),
  )
    .addOption(
      new Option("--file-wins", "Use embedded file ratings as authority").conflicts([
        "dbWins",
        "serverWins",
      ]),
    )
    .addOption(
      new Option("--db-wins", "Use inventory ratings as authority").conflicts([
        "fileWins",
        "serverWins",
      ]),
    )
    .addOption(
      new Option("--server-wins", "Use media-server ratings as authority").conflicts([
        "fileWins",
        "dbWins",
      ]),
    )
    .addOption(new Option("--popm-email <email>", "POPM owner for supported MP3 rating writes"))
    .addOption(new Option("--execute", "Execute the fresh plan instead of previewing it"))
    .addOption(
      new Option("--allow-partial", "Execute independently actionable records despite blockers"),
    )
    .addOption(new Option("-y, --yes", "Approve execution without an interactive prompt"));

  apply.action(async (sourcePath: string, options: RawCommandOptions) => {
    const format = deps.resolveFormat();
    try {
      const strategy = resolveStrategy(options);
      const popmEmail = optionalNonEmptyString(options, "popmEmail", "--popm-email");
      const actionOptions: ReconciliationActionOptions = {
        mode: "apply",
        ...sharedActionOptions(sourcePath, options, format),
        ...strategyFlags(strategy),
        execute: options["execute"] === true,
        allowPartial: options["allowPartial"] === true,
        yes: options["yes"] === true,
        machineOutput: isMachineFormat(format),
        popmEmail,
        signal: resolveSignal(),
      };
      const { executeReconciliation } = await loadActions();
      await emitResult(format, await executeReconciliation(actionOptions));
    } catch (error: unknown) {
      await reportFailure(format, error, [options["popmEmail"]]);
    }
  });

  command.addCommand(apply);
  return command;
}

/** Production command instance registered by the root CLI. */
export const reconcileCommand = createReconcileCommand({
  resolveFormat: getOutputFormat,
});
