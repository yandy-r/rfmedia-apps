/**
 * Human text surface for `rfapps state rebuild`: the stderr report and the
 * pre-rewrite confirmation prompt.
 *
 * Stderr-only, so stdout stays clean for machine formats. Split out of
 * `actions/state-rebuild.ts` purely to keep both files inside the file-size cap;
 * it holds no business logic and makes no decisions the result envelope (or the
 * read-only probe) has not already recorded.
 */

import { colors, logInfo, logSuccess, logWarn } from "@rfmedia/common";

import { getDefaultDatabasePath } from "../lib/index.js";
import type {
  StateDatabaseProbe,
  StateRebuildDisposition,
  StateRebuildMode,
  StateRebuildResult,
  StateRebuildServiceResult,
} from "../types/state-rebuild.js";

function shortId(imageId: string | undefined): string {
  if (imageId === undefined) return "";
  return imageId.startsWith("sha256:") ? imageId.slice(7, 19) : imageId.slice(0, 12);
}

function select(
  result: StateRebuildResult,
  disposition: StateRebuildDisposition,
): StateRebuildServiceResult[] {
  return result.services.filter((service) => service.disposition === disposition);
}

/** Path, readability, schema version, integrity and row counts of the source. */
function renderDatabase(probe: StateDatabaseProbe): void {
  logInfo(colors.bold("  Database:"));
  logInfo(`    Path: ${probe.path}`);

  const details: string[] = [];
  if (probe.schemaVersion !== undefined) details.push(`schema v${probe.schemaVersion}`);
  if (probe.integrity !== undefined) details.push(`integrity ${probe.integrity}`);
  const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
  logInfo(`    Status: ${probe.status}${suffix}`);

  if (probe.status === "readable") {
    logInfo(
      `    Rows: ${probe.deployments ?? 0} deployment(s), ${probe.generations ?? 0} generation(s), ` +
        `${probe.trackedServices?.length ?? 0} tracked service(s)`,
    );
    if (probe.oldestTimestamp !== undefined && probe.newestTimestamp !== undefined) {
      logInfo(`    Range: ${probe.oldestTimestamp} .. ${probe.newestTimestamp}`);
    }
  }
  if (probe.reason !== undefined) {
    logWarn(`    Reason: ${probe.reason}`);
  }

  // Every other rfapps command reads the default path, so a redirected database
  // means the operator is inspecting a different file than `history` reads.
  if (!probe.isDefaultPath) {
    logWarn(
      `Resolved state database ${probe.path} differs from the default ${getDefaultDatabasePath()}; ` +
        "other rfapps commands read the default path.",
    );
  }
}

/** Sections that stay collapsed to one line unless `--show-unchanged`. */
function renderQuiet(
  label: string,
  services: readonly StateRebuildServiceResult[],
  showUnchanged: boolean,
): void {
  if (services.length === 0) return;
  if (!showUnchanged) {
    logInfo(colors.dim(`  ${label}: ${services.length} (use --show-unchanged to list)`));
    return;
  }
  logInfo(colors.bold(`  ${label} (${services.length}):`));
  for (const service of services) {
    const reason = service.reason === undefined ? "" : `  (${service.reason})`;
    logInfo(colors.dim(`    ${service.service}${reason}`));
  }
}

/**
 * Renders the `stale` services, split by why they were left alone.
 *
 * A pre-v3 row carries no `recordedImageId` at all — migration v3 deliberately
 * never backfilled image identity — so its presence here is not drift and every
 * tracked service of a genuine v1/v2 database lands in that group. Prescribing
 * `rfapps reconcile` for those would tell the operator to churn the whole stack
 * over a schema artefact. Drift (a recorded id that disagrees with runtime) does
 * warrant reconciliation, so the two are reported separately with their own
 * services. Classification itself belongs to `actions/state-rebuild.ts`.
 */
function renderStale(stale: readonly StateRebuildServiceResult[]): void {
  const legacy = stale.filter((service) => service.recordedImageId === undefined);
  const drift = stale.filter((service) => service.recordedImageId !== undefined);

  if (drift.length > 0) {
    logWarn(colors.bold(`  Stale — reported, never rewritten (${drift.length}):`));
    for (const service of drift) {
      logWarn(
        `    ${service.service}  (${service.reason ?? "recorded image id differs from runtime"})`,
      );
    }
    logWarn("    Resolve with `rfapps reconcile` or `rfapps deploy`; a rebuild must not record");
    logWarn("    un-reconciled drift as the newest generation.");
  }

  if (legacy.length > 0) {
    logInfo(colors.bold(`  Predate image-identity tracking — left untouched (${legacy.length}):`));
    for (const service of legacy) {
      logInfo(
        `    ${service.service}  (${service.reason ?? "no recorded image identity (pre-v3 row)"})`,
      );
    }
    logInfo("    No drift was detected: these rows were recorded before schema v3 tracked image");
    logInfo("    identity, and the migration does not backfill it. The next ordinary `rfapps");
    logInfo("    deploy` or `rfapps update` records identity for them; nothing to do now.");
  }
}

function renderDispositions(result: StateRebuildResult, showUnchanged: boolean): void {
  const reconstructed = select(result, "reconstructed");
  if (reconstructed.length > 0) {
    const heading = result.phase === "rewrite" ? "Reconstructed" : "Would reconstruct";
    logInfo(colors.bold(`  ${heading} (${reconstructed.length}):`));
    for (const service of reconstructed) {
      const outcome = service.written
        ? colors.green(` written (generation #${service.generation ?? 1})`)
        : colors.dim(" would write a baseline");
      logInfo(
        `    ${service.service}  ${service.imageTag ?? "<unknown image>"}  ` +
          `${shortId(service.imageId)}${outcome}`,
      );
    }
  }

  renderStale(select(result, "stale"));

  const uninspectable = select(result, "uninspectable");
  if (uninspectable.length > 0) {
    logWarn(colors.bold(`  Uninspectable (${uninspectable.length}):`));
    for (const service of uninspectable) {
      logWarn(
        `    ${service.service}  (skipped: ${service.reason ?? "container inspection failed"})`,
      );
    }
  }

  renderQuiet("Carried", select(result, "carried"), showUnchanged);
  renderQuiet("Declared but not observed", select(result, "absent"), showUnchanged);
  renderQuiet("Orphaned", select(result, "orphaned"), showUnchanged);
}

function renderDropped(result: StateRebuildResult): void {
  const dropped = result.summary.droppedServices;
  if (dropped.length === 0) return;
  logWarn(colors.bold(`  History that will be dropped (${dropped.length}):`));
  for (const service of dropped) {
    logWarn(`    ${service}`);
  }
}

function renderCarryOver(result: StateRebuildResult): void {
  const carryOver = result.carryOver;
  if (carryOver === undefined) return;
  logInfo(colors.bold("  Carry-over:"));
  logInfo(
    `    Carried ${carryOver.deploymentsCarried} deployment(s) and ` +
      `${carryOver.generationsCarried} generation(s); re-derived ${carryOver.generationsDerived}.`,
  );
  const discarded = `${carryOver.deploymentsDiscarded} deployment(s), ${carryOver.generationsDiscarded} generation(s)`;
  if (carryOver.deploymentsDiscarded > 0 || carryOver.generationsDiscarded > 0) {
    logWarn(`    Discarded unreadable rows: ${discarded}`);
  } else {
    logInfo(colors.dim(`    Discarded unreadable rows: ${discarded}`));
  }
}

function renderOutcome(result: StateRebuildResult): void {
  if (result.refusal !== undefined) {
    logWarn(result.refusal.message);
    return;
  }

  // An abandoned rewrite keeps `phase: "report"` (nothing was replaced), so it would otherwise fall
  // into the branch below and advise running `--rewrite` — the exact flag the operator just ran.
  // The action has already logged why it was abandoned and named the backup.
  if (result.failure !== undefined) {
    return;
  }

  if (result.phase !== "rewrite") {
    logInfo("No changes were made. Run `rfapps state rebuild --rewrite` to replace the database.");
    return;
  }

  const backup = result.backup;
  if (backup !== undefined) {
    logInfo(`  Backup: ${backup.path} (${backup.method}, ${backup.bytes} bytes)`);
  }
  logSuccess(
    `Rebuilt ${result.database.path} from Docker runtime. compose.yml and containers unchanged.`,
  );

  // A missing target is backed up by nobody: there was no previous database to
  // copy, so a restore recipe would print an unrunnable command and imply one
  // existed.
  if (backup === undefined) {
    logInfo("  No backup was needed: no previous database existed at that path.");
    return;
  }
  logInfo("  Restore the previous database with:");
  logInfo("    rfapps force-unlock                                    # only if a lock is stuck");
  logInfo(`    cp ${backup.path} ${result.database.path}`);
}

/**
 * Builds the prompt shown before an authorized rewrite.
 *
 * The row counts come from the READ-ONLY probe: carry-over has not run yet and
 * must not run before the operator has approved.
 *
 * @param mode - Reconstruction strategy the operator selected
 * @param probe - Read-only diagnosis of the database about to be replaced
 * @param baselines - Services that would gain a reconstructed baseline row
 * @param dropped - Services whose history would not survive the replacement
 * @param backupPath - Destination of the mandatory pre-rewrite backup
 */
export function buildStateRebuildConfirmation(
  mode: StateRebuildMode,
  probe: StateDatabaseProbe,
  baselines: number,
  dropped: number,
  backupPath: string,
): string {
  const deployments = probe.deployments ?? 0;
  const generations = probe.generations ?? 0;
  if (mode === "runtime-only") {
    return (
      `DISCARD ${deployments} deployment row(s) and ${generations} generation(s) at ${probe.path} ` +
      `and rebuild ${baselines} baseline(s) from Docker? History for ${dropped} service(s) will ` +
      "be dropped and every service restarts at generation #1. " +
      `A backup will be written to ${backupPath}.`
    );
  }
  return (
    `Replace ${probe.path} with a database rebuilt from Docker? ${deployments} deployment row(s) ` +
    `and ${generations} generation(s) will be carried, ${baselines} baseline(s) added, history ` +
    `for ${dropped} service(s) dropped. A backup will be written to ${backupPath}.`
  );
}

/**
 * Renders one rebuild result to stderr.
 *
 * @param result - The completed report or rewrite envelope
 * @param showUnchanged - Expand the carried / absent / orphaned sections
 */
export function renderStateRebuildReport(result: StateRebuildResult, showUnchanged: boolean): void {
  const heading = result.phase === "rewrite" ? "State rebuild applied" : "State rebuild report";
  logInfo(`${heading}: ${result.project} (mode: ${result.mode})`);
  renderDatabase(result.database);
  renderDispositions(result, showUnchanged);
  renderDropped(result);
  renderCarryOver(result);
  renderOutcome(result);
}
