/**
 * State-database reconstruction action for rfapps CLI.
 *
 * Report-first recovery for the WHOLE state database: a bare invocation opens
 * the existing file read-only, observes Docker and compose, and prints the
 * database that would be built. Only `--rewrite` authorizes a replacement, and
 * even then the existing file is never opened read-write — a complete
 * replacement is built beside it and renamed over it, so any failure before the
 * swap is indistinguishable from "nothing happened". The pre-rewrite backup is
 * mandatory and cannot be disabled.
 *
 * Compose supplies only the ENUMERATION of services; the container supplies
 * every VALUE, so a compose file edited after deployment cannot poison a
 * recovered baseline. This is NOT `rfapps rebuild`: no container is mutated and
 * compose.yml is never modified.
 */

import { rm } from "node:fs/promises";

import {
  confirm,
  formatError,
  isMachineFormat,
  logWarn,
  outputFormattedError,
} from "@rfmedia/common";
import type { OutputFormat } from "@rfmedia/common";

import { getEnvToolExecConfig } from "../types/index.js";
import type { EnvToolExecConfig } from "../types/options.js";
import type { StateEntryInput } from "../types/state.js";
import {
  STATE_REBUILD_SCHEMA_VERSION,
  type CarryOverCounts,
  type RawStateRebuildOptions,
  type StateBackupResult,
  type StateCommandGlobalOptions,
  type StateRebuildDisposition,
  type StateRebuildFailure,
  type StateRebuildMode,
  type StateRebuildResult,
  type StateRebuildServiceResult,
  type StateRebuildSummary,
} from "../types/state-rebuild.js";

import {
  applyCliOverrides,
  backupStateDatabase,
  buildReplacementDatabasePath,
  captureRuntimeBaseline,
  carryOverState,
  closeDatabase,
  defaultBackupPath,
  formatOutput,
  getGenerations,
  getStateDbPath,
  initializeDatabase,
  isValidProfile,
  loadConfig,
  openReadOnlyStateDatabase,
  probeStateDatabase,
  readLatestRecordedImageIds,
  recordDeployments,
  resolveComposeProjectIdentity,
  swapStateDatabase,
  toBaselineEntry,
  DockerCommandError,
  InvalidArgumentError,
  GENERATION_ACTIONS,
  type DbConnection,
  type RuntimeBaseline,
} from "../lib/index.js";
import {
  getComposeConfig,
  getComposeContainerObservations,
  type ComposeContainerObservation,
} from "../lib/docker.js";
import { ExitCode, resolveStateRebuildExitCode, setExitCode } from "../lib/exit-codes.js";
import { buildStateRebuildConfirmation, renderStateRebuildReport } from "./state-rebuild-report.js";

/** A service classified `reconstructed`, with the baseline that will be written. */
interface PlannedBaseline {
  readonly result: StateRebuildServiceResult;
  readonly baseline: RuntimeBaseline;
}

/** Everything the disposition sweep needs, gathered read-only beforehand. */
interface ClassificationInput {
  readonly allServices: readonly string[];
  readonly declared: ReadonlySet<string>;
  readonly tracked: ReadonlySet<string>;
  readonly observations: ReadonlyMap<string, ComposeContainerObservation>;
  readonly recordedImageIds: ReadonlyMap<string, string | undefined>;
  readonly mode: StateRebuildMode;
  readonly cwd: string;
  readonly envTool: EnvToolExecConfig | undefined;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function finalize(draft: Omit<StateRebuildResult, "success" | "exitCode">): StateRebuildResult {
  const exitCode = resolveStateRebuildExitCode(draft);
  return { ...draft, success: exitCode === ExitCode.Success, exitCode };
}

/**
 * Terminates a draft as an operational failure.
 *
 * Deliberately does NOT go through `finalize`: `resolveStateRebuildExitCode`
 * classifies a completed rebuild, and every category it can return means the
 * command did its job. An abandoned rewrite is not a category of success, so its
 * exit code is stated here rather than derived.
 */
function finalizeFailure(
  draft: Omit<StateRebuildResult, "success" | "exitCode">,
  failure: StateRebuildFailure,
): StateRebuildResult {
  return { ...draft, failure, success: false, exitCode: ExitCode.OperationalError };
}

async function emit(
  result: StateRebuildResult,
  format: OutputFormat,
  showUnchanged: boolean,
): Promise<void> {
  if (format === "text") {
    renderStateRebuildReport(result, showUnchanged);
  } else {
    await formatOutput(format, result);
  }
  if (result.exitCode !== ExitCode.Success) {
    setExitCode(result.exitCode);
  }
}

/** Reports a failure that left the database untouched, naming both artifacts. */
function reportUntouched(error: unknown, backupPath: string, tempPath: string | undefined): void {
  const replacement = tempPath === undefined ? "" : ` Replacement: ${tempPath}.`;
  logWarn(`The state database was not modified. Backup: ${backupPath}.${replacement}`);
  outputFormattedError(formatError(toError(error)));
  setExitCode(ExitCode.OperationalError);
}

/** Latest observation per service, honouring `--running-only`. */
function indexObservations(
  observations: readonly ComposeContainerObservation[],
  runningOnly: boolean,
): Map<string, ComposeContainerObservation> {
  const indexed = new Map<string, ComposeContainerObservation>();
  for (const observation of observations) {
    if (runningOnly && observation.state !== "running") continue;
    if (!indexed.has(observation.serviceName)) indexed.set(observation.serviceName, observation);
  }
  return indexed;
}

/**
 * Assigns every service its disposition, in the one order the design fixes.
 *
 * Computed against the read-only probe's tracked services, never a writable
 * handle. Only `reconstructed` services yield a row: `stale` is reported and
 * never rewritten, because a fresh baseline for a drifted service would record
 * un-reconciled drift as its newest generation.
 */
async function classifyServices(
  input: ClassificationInput,
): Promise<{ services: StateRebuildServiceResult[]; planned: PlannedBaseline[] }> {
  const services: StateRebuildServiceResult[] = [];
  const planned: PlannedBaseline[] = [];

  for (const service of input.allServices) {
    const observation = input.observations.get(service);

    if (observation === undefined) {
      const declared = input.declared.has(service);
      services.push({
        service,
        disposition: declared ? "absent" : "orphaned",
        written: false,
        recordedImageId: input.recordedImageIds.get(service),
        reason: declared
          ? "declared but no container was observed"
          : "has state rows but is neither declared nor observed",
      });
      continue;
    }

    const result: StateRebuildServiceResult = {
      service,
      disposition: "reconstructed",
      container: observation.containerName,
      containerState: observation.state,
      written: false,
    };

    const baseline = await captureRuntimeBaseline(observation.containerName, {
      cwd: input.cwd,
      envTool: input.envTool,
    });
    if (baseline === undefined) {
      result.disposition = "uninspectable";
      result.reason = "container inspection failed";
      services.push(result);
      continue;
    }

    result.imageTag = baseline.identity.configuredImage;
    result.imageId = baseline.identity.localImageId;
    result.imageDigest = baseline.identity.repositoryDigest;

    if (input.mode === "salvage" && input.tracked.has(service)) {
      const recorded = input.recordedImageIds.get(service);
      result.recordedImageId = recorded;
      if (recorded !== undefined && recorded === baseline.identity.localImageId) {
        result.disposition = "carried";
      } else {
        // A genuine v1/v2 source records no image id at all (migration v3
        // deliberately does not backfill it), so the two cases must be told
        // apart or a legacy rebuild sends the operator to `rfapps reconcile`
        // for the entire stack with no explanation.
        result.disposition = "stale";
        result.reason =
          recorded === undefined
            ? "no recorded image identity (pre-v3 row)"
            : "recorded image id differs from runtime";
      }
      services.push(result);
      continue;
    }

    services.push(result);
    planned.push({ result, baseline });
  }

  return { services, planned };
}

function buildSummary(
  services: readonly StateRebuildServiceResult[],
  declared: number,
  observed: number,
  droppedServices: string[],
): StateRebuildSummary {
  const count = (disposition: StateRebuildDisposition): number =>
    services.filter((service) => service.disposition === disposition).length;
  return {
    declared,
    observed,
    reconstructed: count("reconstructed"),
    carried: count("carried"),
    stale: count("stale"),
    orphaned: count("orphaned"),
    absent: count("absent"),
    uninspectable: count("uninspectable"),
    droppedServices,
    discardedDeployments: 0,
    discardedGenerations: 0,
  };
}

/** Outcome of a replacement build; `swapped: false` means the target is untouched. */
interface ReplacementOutcome {
  readonly carryOver: CarryOverCounts;
  readonly swapped: boolean;
}

/**
 * Builds the replacement at the temp path and swaps it into place.
 *
 * `initializeDatabase` is called EXCLUSIVELY here, on the temp path. Generation
 * numbers are never chosen by this feature: the number `createGeneration`
 * actually assigned is read back per written service.
 *
 * `acceptCarryOver` is the caller's veto: `carryOverState` never throws, so a
 * total salvage failure is only visible in its counts. Returning false abandons
 * the replacement before a single baseline is written and before the swap.
 *
 * @throws Rethrows any build or swap failure after removing the temp file
 */
async function writeReplacement(
  dbPath: string,
  tempPath: string,
  source: DbConnection | undefined,
  planned: readonly PlannedBaseline[],
  closeSource: () => void,
  acceptCarryOver: (counts: CarryOverCounts) => boolean,
): Promise<ReplacementOutcome> {
  let carryOver: CarryOverCounts = {
    deploymentsCarried: 0,
    deploymentsDiscarded: 0,
    generationsCarried: 0,
    generationsDiscarded: 0,
    generationsDerived: 0,
  };
  let target: DbConnection | undefined;

  try {
    const db = await initializeDatabase(tempPath);
    target = db;

    if (source !== undefined) {
      carryOver = carryOverState(source, db, GENERATION_ACTIONS);
      if (!acceptCarryOver(carryOver)) {
        closeDatabase(db);
        target = undefined;
        return { carryOver, swapped: false };
      }
    }

    if (planned.length > 0) {
      const timestamp = new Date().toISOString();
      const entries: StateEntryInput[] = planned.map((entry) =>
        toBaselineEntry(entry.result.service, entry.baseline, timestamp),
      );
      const ids = recordDeployments(db, entries);
      planned.forEach((entry, index) => {
        entry.result.written = true;
        entry.result.deploymentId = ids[index];
        entry.result.generation = getGenerations(db, {
          service: entry.result.service,
          limit: 1,
        })[0]?.generation;
      });
    }

    closeDatabase(db);
    target = undefined;
    closeSource();

    await swapStateDatabase(tempPath, dbPath);
    return { carryOver, swapped: true };
  } finally {
    if (target !== undefined) closeDatabase(target);
    await rm(tempPath, { force: true });
  }
}

/**
 * Executes `rfapps state rebuild`: report the database that would be built from
 * Docker runtime and compose declarations, and replace it when authorized.
 */
export async function executeStateRebuild(
  rawOptions: RawStateRebuildOptions,
  globalOptions: StateCommandGlobalOptions,
): Promise<void> {
  const format: OutputFormat =
    globalOptions.output ?? (globalOptions.json === true ? "json" : "text");
  const dryRun = globalOptions.dryRun ?? false;
  const yes = globalOptions.yes ?? false;
  const mode: StateRebuildMode = rawOptions.mode ?? "salvage";
  const showUnchanged = rawOptions.showUnchanged ?? false;
  const rewriteRequested = rawOptions.rewrite ?? false;

  // Global --dry-run vetoes the rewrite even when --rewrite is present.
  if (rewriteRequested && dryRun) {
    logWarn("--dry-run overrides --rewrite; the state database will not be replaced.");
  }
  const willRewrite = rewriteRequested && !dryRun;

  const config = await loadConfig();
  if (rawOptions.profile !== undefined && !isValidProfile(rawOptions.profile, config)) {
    throw new InvalidArgumentError(
      "--profile",
      rawOptions.profile,
      "Unknown profile",
      config.profiles.validProfiles,
    );
  }
  const finalConfig = applyCliOverrides(config, {
    composePath: rawOptions.compose,
    envFile: rawOptions.envFile,
    profile: rawOptions.profile,
  });

  // Authorization guards run BEFORE any Docker, probe or filesystem work.
  // Global --yes never grants write authority; it only skips the confirmation.
  if (willRewrite && finalConfig.state?.enabled === false) {
    throw new InvalidArgumentError(
      "--rewrite",
      "true",
      "State tracking is disabled; enable it to rebuild the state database",
    );
  }
  if (
    willRewrite &&
    mode === "runtime-only" &&
    (rawOptions.confirmProject === undefined || rawOptions.confirmProject.trim() === "")
  ) {
    throw new InvalidArgumentError(
      "--confirm-project",
      "",
      "Discarding existing history requires the Compose project name",
    );
  }
  if (willRewrite && isMachineFormat(format) && !yes) {
    throw new InvalidArgumentError(
      "--yes",
      "false",
      "Machine-format rebuild requires explicit --rewrite --yes",
    );
  }

  const envTool = getEnvToolExecConfig(globalOptions, finalConfig);
  const profiles = [finalConfig.profiles.defaultProfile];

  // Realpath'd, symlink-free compose file and a validated project name. Running
  // from the wrong directory during a whole-file replacement would reconstruct
  // the WRONG project's state, so projectDir is the cwd for every Docker call.
  const identity = await resolveComposeProjectIdentity(finalConfig.composePath, {
    envFile: finalConfig.envFile,
    envTool,
  });
  if (
    willRewrite &&
    mode === "runtime-only" &&
    rawOptions.confirmProject !== identity.projectName
  ) {
    throw new InvalidArgumentError(
      "--confirm-project",
      rawOptions.confirmProject ?? "",
      "Does not match the resolved Compose project",
      [identity.projectName],
    );
  }

  const composeConfig = await getComposeConfig(identity.composePath, {
    profiles,
    envFile: finalConfig.envFile,
    projectName: identity.projectName,
    envTool,
    cwd: identity.projectDir,
  });
  if (composeConfig === undefined) {
    outputFormattedError(
      formatError(
        new DockerCommandError("config", "Failed to read Compose configuration", 1, [], false),
      ),
    );
    setExitCode(ExitCode.OperationalError);
    return;
  }
  const declared = Object.keys(composeConfig.services).sort();

  // `ps --all` also sees created-but-exited containers, which still hold
  // recoverable image identity after a host failure.
  const observations = indexObservations(
    await getComposeContainerObservations(identity.composePath, {
      profiles,
      envFile: finalConfig.envFile,
      projectName: identity.projectName,
      envTool,
      cwd: identity.projectDir,
    }),
    rawOptions.runningOnly === true,
  );

  // Resolved ONCE, so it is impossible to back up one file and rewrite another.
  const dbPath = getStateDbPath(finalConfig);
  const probe = await probeStateDatabase(dbPath);

  // The source handle is gated on the PROBE, never on the open: a corrupt file
  // opens fine read-only and only throws on the first read, so opening it would
  // make salvage crash on exactly the database it exists to recover.
  const source = probe.status === "readable" ? openReadOnlyStateDatabase(dbPath) : undefined;
  let sourceClosed = false;
  const closeSource = (): void => {
    if (source !== undefined && !sourceClosed) {
      closeDatabase(source);
      sourceClosed = true;
    }
  };

  try {
    const trackedServices = probe.trackedServices ?? [];
    const recordedImageIds =
      source === undefined
        ? new Map<string, string | undefined>()
        : readLatestRecordedImageIds(source);

    const { services, planned } = await classifyServices({
      allServices: [...new Set([...declared, ...trackedServices, ...observations.keys()])].sort(),
      declared: new Set(declared),
      tracked: new Set(trackedServices),
      observations,
      recordedImageIds,
      mode,
      cwd: identity.projectDir,
      envTool,
    });

    // A missing or unreadable source degenerates salvage into runtime-only.
    const carrySource = mode === "salvage" ? source : undefined;
    const reconstructed = new Set(planned.map((entry) => entry.result.service));
    const droppedServices =
      carrySource === undefined
        ? [...trackedServices].filter((service) => !reconstructed.has(service)).sort()
        : [];

    const summary = buildSummary(services, declared.length, observations.size, droppedServices);
    const draft: Omit<StateRebuildResult, "success" | "exitCode"> = {
      schemaVersion: STATE_REBUILD_SCHEMA_VERSION,
      operation: "state-rebuild",
      phase: "report",
      mode,
      project: identity.projectName,
      composePath: identity.composePath,
      database: probe,
      services,
      summary,
    };

    // Report phase: writes no file — not even a backup — and takes no lock.
    if (!willRewrite) {
      await emit(finalize(draft), format, showUnchanged);
      return;
    }

    // Neither "the Docker daemon is down" nor "everything is stopped" may ever
    // be reported as a successful rebuild.
    const carryable = carrySource === undefined ? 0 : (probe.deployments ?? 0);
    if (carryable === 0 && planned.length === 0) {
      const message =
        `Refusing to rewrite ${dbPath}: the replacement would contain zero deployment rows. ` +
        "Nothing was backed up and nothing was written. Verify that Docker is reachable and " +
        "this project's containers exist (`docker compose ps --all`).";
      await emit(
        finalize({ ...draft, refusal: { reason: "empty-plan", message } }),
        format,
        showUnchanged,
      );
      return;
    }

    const backupPath = defaultBackupPath(dbPath, rawOptions.backupDir, new Date());

    if (format === "text" && !yes) {
      const approved = await confirm(
        buildStateRebuildConfirmation(
          mode,
          probe,
          planned.length,
          droppedServices.length,
          backupPath,
        ),
      );
      if (!approved) {
        logWarn("State rebuild cancelled; the state database was not modified.");
        renderStateRebuildReport(finalize(draft), showUnchanged);
        setExitCode(ExitCode.UsageError);
        return;
      }
    }

    // Strict order: probe -> backup -> build replacement -> swap. There is no
    // --no-backup and there must never be one.
    let backup: StateBackupResult | undefined;
    if (probe.status !== "missing") {
      try {
        backup = await backupStateDatabase(dbPath, backupPath);
      } catch (error) {
        reportUntouched(error, backupPath, undefined);
        return;
      }
    }

    // `carryOverState` never throws, so a wholesale rollback (or a source column
    // list it could not use) is indistinguishable from "the source was empty" in
    // its counts alone. Reconcile them against the read-only probe: a source the
    // probe read as holding deployments that yields neither a carried nor a
    // discarded row salvaged nothing, and swapping in that replacement would
    // destroy the entire history while reporting a clean rebuild.
    const carryExpected = carrySource !== undefined && (probe.deployments ?? 0) > 0;
    const acceptCarryOver = (counts: CarryOverCounts): boolean =>
      !carryExpected || counts.deploymentsCarried + counts.deploymentsDiscarded > 0;

    const tempPath = buildReplacementDatabasePath(dbPath);
    let outcome: ReplacementOutcome;
    try {
      outcome = await writeReplacement(
        dbPath,
        tempPath,
        carrySource,
        planned,
        closeSource,
        acceptCarryOver,
      );
    } catch (error) {
      reportUntouched(error, backupPath, tempPath);
      return;
    }

    summary.discardedDeployments = outcome.carryOver.deploymentsDiscarded;
    summary.discardedGenerations = outcome.carryOver.generationsDiscarded;

    if (!outcome.swapped) {
      const message =
        `Salvage carried none of the ${probe.deployments ?? 0} deployment rows in ${dbPath}, ` +
        "so the replacement would have contained no history at all; it was discarded. " +
        `The state database was not modified. Backup: ${backupPath}.`;
      logWarn(message);
      await emit(
        finalizeFailure(
          { ...draft, backup, carryOver: outcome.carryOver },
          {
            reason: "carry-over-failed",
            message,
          },
        ),
        format,
        showUnchanged,
      );
      return;
    }

    await emit(
      finalize({ ...draft, phase: "rewrite", backup, carryOver: outcome.carryOver }),
      format,
      showUnchanged,
    );
  } finally {
    closeSource();
  }
}
