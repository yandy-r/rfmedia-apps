/**
 * State export action for rfapps CLI.
 *
 * Writes a consistent, private, restore-with-one-`cp` copy of the rfapps state
 * database. Read-only by construction: the source is never opened read-write and
 * the state lock is never acquired, so a precautionary backup is never blocked by
 * a stuck lock and stays safe under a concurrent rfapps mutation (SQLite's online
 * backup API is consistent under a concurrent writer).
 *
 * The target file is resolved exactly once with `getStateDbPath`, the same rule
 * `rfapps state rebuild` uses, so it is impossible to back up one file and rebuild
 * another.
 */

import { formatError, logInfo, logSuccess, logWarn, outputFormattedError } from "@rfmedia/common";
import type { OutputFormat } from "@rfmedia/common";

import {
  STATE_EXPORT_SCHEMA_VERSION,
  type RawStateExportOptions,
  type StateBackupResult,
  type StateCommandGlobalOptions,
  type StateDatabaseProbe,
  type StateExportExitCode,
  type StateExportResult,
} from "../types/state-rebuild.js";

import {
  backupStateDatabase,
  defaultBackupPath,
  formatOutput,
  getStateDbPath,
  loadConfig,
  probeStateDatabase,
} from "../lib/index.js";
import { ExitCode, resolveStateExportExitCode, setExitCode } from "../lib/exit-codes.js";
import type { ExitCodeValue } from "../lib/exit-codes.js";

/**
 * Narrows the shared exit-code union to the codes `state export` documents.
 *
 * `resolveStateExportExitCode` only ever returns success or operational failure —
 * a backup either exists or it does not, so there is no partial outcome to report.
 */
function toStateExportExitCode(code: ExitCodeValue): StateExportExitCode {
  return code === ExitCode.PartialSuccess ? ExitCode.OperationalError : code;
}

function buildResult(
  probe: StateDatabaseProbe,
  destination: string,
  backup: StateBackupResult | undefined,
  dryRun: boolean,
): StateExportResult {
  const base: Omit<StateExportResult, "success" | "exitCode"> = {
    schemaVersion: STATE_EXPORT_SCHEMA_VERSION,
    operation: "state-export",
    database: probe,
    destination,
    backup,
    dryRun,
  };
  const exitCode = toStateExportExitCode(resolveStateExportExitCode(base));

  return { ...base, success: exitCode === ExitCode.Success, exitCode };
}

/** Prints the read-only diagnosis of the source file (stderr). */
function renderSource(probe: StateDatabaseProbe): void {
  logInfo(`State database: ${probe.path} (${probe.status})`);
  if (probe.reason !== undefined) {
    logWarn(`Source diagnosis: ${probe.reason}`);
  }
}

/** Prints the artifact summary and the one-command restore line (stderr). */
function renderBackup(backup: StateBackupResult, dbPath: string): void {
  logSuccess(`Wrote ${backup.method} backup (${backup.bytes} bytes) to ${backup.path}`);
  for (const sidecar of backup.sidecars) {
    logInfo(`  Copied sidecar: ${sidecar}`);
  }
  if (backup.method === "raw-copy") {
    logWarn(
      "SQLite could not read the source, so its raw bytes were copied instead. " +
        "The artifact preserves the file for forensics but may not open as a database.",
    );
  }
  logInfo(`Restore with: cp ${backup.path} ${dbPath}`);
}

async function emit(
  result: StateExportResult,
  format: OutputFormat,
  renderText: () => void,
): Promise<void> {
  if (format === "text") {
    renderText();
  } else {
    await formatOutput(format, result);
  }
  if (result.exitCode !== ExitCode.Success) {
    setExitCode(result.exitCode);
  }
}

/**
 * Executes the state export command: diagnose the state database read-only and
 * write a consistent backup copy of it.
 */
export async function executeStateExport(
  rawOptions: RawStateExportOptions,
  globalOptions: StateCommandGlobalOptions,
): Promise<void> {
  const format: OutputFormat =
    globalOptions.output ?? (globalOptions.json === true ? "json" : "text");
  const dryRun = globalOptions.dryRun ?? false;

  const config = await loadConfig();
  const dbPath = getStateDbPath(config);
  const probe = await probeStateDatabase(dbPath);
  const destination = rawOptions.out ?? defaultBackupPath(dbPath, undefined, new Date());

  // Global --dry-run reports the destination and writes nothing at all.
  if (dryRun) {
    const result = buildResult(probe, destination, undefined, true);
    await emit(result, format, () => {
      renderSource(probe);
      logInfo(`Dry run: would write a backup to ${destination}; nothing was written.`);
    });
    return;
  }

  let backup: StateBackupResult;
  try {
    backup = await backupStateDatabase(dbPath, destination);
  } catch (error) {
    const errorObj = error instanceof Error ? error : new Error(String(error));
    outputFormattedError(formatError(errorObj));
    setExitCode(ExitCode.OperationalError);
    return;
  }

  const result = buildResult(probe, destination, backup, false);
  await emit(result, format, () => {
    renderSource(probe);
    renderBackup(backup, dbPath);
  });
}
