/**
 * Import command action for rfapps CLI.
 *
 * Adopts running Docker Compose services that were created outside rfapps-cli
 * (via `docker compose up`, legacy `manage.sh`, etc.) into rfapps SQLite state
 * tracking by recording a baseline deployment + generation snapshot per service.
 *
 * Report-first: a bare invocation only previews the services that would be
 * adopted and writes nothing. `--adopt` authorizes the state write. The command
 * never modifies compose.yml and never mutates containers — this is the critical
 * distinction from the `drift import` subcommand (which rewrites compose.yml).
 */

import {
  logInfo,
  logSuccess,
  logWarn,
  confirm,
  colors,
  isMachineFormat,
  formatError,
  outputFormattedError,
} from "@rfmedia/common";
import type { OutputFormat } from "@rfmedia/common";

import { getEnvToolExecConfig } from "../types/index.js";
import type { StateEntryInput } from "../types/state.js";
import {
  IMPORT_SCHEMA_VERSION,
  type ImportResult,
  type ImportServiceResult,
  type ImportSummary,
  type ImportExitCode,
} from "../types/import.js";

import {
  loadConfig,
  applyCliOverrides,
  isValidProfile,
  resolveServicesWithInteractive,
  formatOutput,
  initializeDatabase,
  closeDatabase,
  recordDeployments,
  getDeploymentCount,
  InvalidArgumentError,
  DockerCommandError,
} from "../lib/index.js";
import { getComposeConfig, getRunningServiceContainerMap } from "../lib/docker.js";
import {
  captureRuntimeBaseline,
  toBaselineEntry,
  type RuntimeBaseline,
} from "../lib/runtime-baseline.js";
import { ExitCode, setExitCode } from "../lib/exit-codes.js";

/** Raw options parsed by Commander for the import command. */
export interface RawImportOptions {
  service?: string;
  services?: string;
  group?: string;
  tag?: string[];
  /** Commander sets this to false when `--no-sidecars` is passed. */
  sidecars?: boolean;
  /** Authorizes writing baseline snapshots (report-first otherwise). */
  adopt?: boolean;
  /** Include already-tracked and not-running services in the report. */
  showTracked?: boolean;
  compose?: string;
  envFile?: string;
  profile?: string;
}

/** Global options forwarded from the root program. */
export interface ImportGlobalOptions {
  dryRun?: boolean;
  debug?: boolean;
  json?: boolean;
  output?: OutputFormat;
  verbose?: boolean;
  yes?: boolean;
  useDotenvx?: string;
  useOp?: string;
}

/** A candidate that inspected cleanly and is ready to be recorded. */
interface Adoptable {
  result: ImportServiceResult;
  captured: RuntimeBaseline;
}

function summarize(services: ImportServiceResult[], imported: number): ImportSummary {
  return {
    total: services.length,
    candidates: services.filter((service) => service.classification === "candidate").length,
    imported,
    tracked: services.filter((service) => service.classification === "tracked").length,
    absent: services.filter((service) => service.classification === "absent").length,
    uninspectable: services.filter((service) => service.classification === "uninspectable").length,
  };
}

function buildResult(
  mode: "preview" | "adopt",
  project: string,
  composePath: string,
  services: ImportServiceResult[],
  imported: number,
): ImportResult {
  const summary = summarize(services, imported);
  // Exit 3 (partial) is reserved for an authorized adoption that could not fully
  // complete. A read-only preview never mutates state, so an uninspectable
  // container there is surfaced as a warning and still exits 0.
  const exitCode: ImportExitCode = mode === "adopt" && summary.uninspectable > 0 ? 3 : 0;
  return {
    schemaVersion: IMPORT_SCHEMA_VERSION,
    operation: "import",
    mode,
    project,
    composePath,
    services,
    summary,
    success: exitCode === 0,
    exitCode,
  };
}

function shortId(imageId: string | undefined): string {
  if (imageId === undefined) return "";
  return imageId.startsWith("sha256:") ? imageId.slice(7, 19) : imageId.slice(0, 12);
}

/** Renders the human (text) report to stderr, grouped by disposition. */
function renderReport(result: ImportResult, showTracked: boolean): void {
  logInfo(`Import report: ${result.project}`);

  const candidates = result.services.filter((service) => service.classification === "candidate");
  const uninspectable = result.services.filter(
    (service) => service.classification === "uninspectable",
  );
  const tracked = result.services.filter((service) => service.classification === "tracked");
  const absent = result.services.filter((service) => service.classification === "absent");

  if (candidates.length > 0) {
    const heading = result.mode === "adopt" ? "Adopted" : "Import candidates";
    logInfo(colors.bold(`  ${heading} (${candidates.length}):`));
    for (const service of candidates) {
      const idPart = shortId(service.imageId);
      const suffix = service.imported
        ? colors.green(` adopted (generation #${service.generation ?? 1})`)
        : colors.dim(" would import");
      logInfo(
        `    ${service.service}  ${service.imageTag ?? "<unknown image>"}  ${idPart}${suffix}`,
      );
    }
  }

  if (uninspectable.length > 0) {
    logWarn(colors.bold(`  Uninspectable (${uninspectable.length}):`));
    for (const service of uninspectable) {
      logWarn(`    ${service.service}  (skipped: ${service.reason ?? "inspection failed"})`);
    }
  }

  if (showTracked && tracked.length > 0) {
    logInfo(colors.bold(`  Already tracked (${tracked.length}):`));
    for (const service of tracked) {
      logInfo(colors.dim(`    ${service.service}  (skipped: already tracked)`));
    }
  }

  if (showTracked && absent.length > 0) {
    logInfo(colors.bold(`  Declared but not running (${absent.length}):`));
    for (const service of absent) {
      logInfo(colors.dim(`    ${service.service}  (skipped: not running)`));
    }
  }

  if (result.mode === "adopt" && result.summary.imported > 0) {
    logSuccess(
      `Adopted ${result.summary.imported} service(s) (baseline generation recorded). compose.yml unchanged.`,
    );
  } else if (candidates.length === 0 && uninspectable.length === 0) {
    logSuccess("Nothing to import — all running services are already tracked.");
  } else if (result.mode === "preview") {
    logInfo("No changes were made. Run `rfapps import --adopt` to record baselines.");
  }
}

async function emit(
  result: ImportResult,
  format: OutputFormat,
  showTracked: boolean,
): Promise<void> {
  if (format === "text") {
    renderReport(result, showTracked);
  } else {
    await formatOutput(format, result);
  }
  if (result.exitCode !== 0) {
    setExitCode(result.exitCode);
  }
}

/**
 * Executes the import command: discover running-but-untracked services and,
 * when authorized with `--adopt`, record a baseline snapshot for each.
 */
export async function executeImport(
  rawOptions: RawImportOptions,
  globalOptions: ImportGlobalOptions,
): Promise<void> {
  const format: OutputFormat =
    globalOptions.output ?? (globalOptions.json === true ? "json" : "text");
  const dryRun = globalOptions.dryRun ?? false;
  const yes = globalOptions.yes ?? false;
  const showTracked = rawOptions.showTracked ?? false;
  const noSidecars = rawOptions.sidecars === false;
  const adoptRequested = rawOptions.adopt ?? false;

  // Global --dry-run vetoes the write even with --adopt (mirrors reconcile's
  // --auto-apply veto): fall back to a read-only preview.
  if (adoptRequested && dryRun) {
    logWarn("--dry-run overrides --adopt; no baselines will be written.");
  }
  const willAdopt = adoptRequested && !dryRun;

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
    profile:
      rawOptions.profile !== undefined && isValidProfile(rawOptions.profile, config)
        ? rawOptions.profile
        : undefined,
    noSidecars,
  });

  // Authorization guards (independent of discovery) run before any Docker/DB work.
  if (willAdopt && finalConfig.state?.enabled === false) {
    throw new InvalidArgumentError(
      "--adopt",
      "true",
      "State tracking is disabled; enable it to import baselines",
    );
  }
  if (willAdopt && isMachineFormat(format) && !yes) {
    throw new InvalidArgumentError(
      "--yes",
      "false",
      "Machine-format adoption requires explicit --adopt --yes",
    );
  }

  const envTool = getEnvToolExecConfig(globalOptions, finalConfig);

  const resolved = await resolveServicesWithInteractive(
    {
      service: rawOptions.service,
      services: rawOptions.services
        ?.split(",")
        .map((service) => service.trim())
        .filter((service) => service.length > 0),
      group: rawOptions.group,
      tag: rawOptions.tag,
      noSidecars,
      sidecars: noSidecars ? false : undefined,
      // Import selection is deterministic; never enter interactive multi-select.
      yes: true,
    },
    finalConfig,
    finalConfig.composePath,
    process.cwd(),
    { envTool },
  );
  if (resolved === null) return;

  const profiles = resolved.profiles;

  const composeConfig = await getComposeConfig(finalConfig.composePath, {
    profiles,
    envFile: finalConfig.envFile,
    envTool,
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
  const project = composeConfig.name ?? "compose";
  const declared = Object.keys(composeConfig.services);
  const scope =
    resolved.services.length > 0
      ? declared.filter((service) => resolved.services.includes(service))
      : declared;
  const services = [...scope].sort();

  const running = await getRunningServiceContainerMap(finalConfig.composePath, {
    profiles,
    envFile: finalConfig.envFile,
    cwd: process.cwd(),
    envTool,
  });
  if (running === undefined) {
    outputFormattedError(
      formatError(
        new DockerCommandError("ps", "Failed to observe running containers", 1, services, false),
      ),
    );
    setExitCode(ExitCode.OperationalError);
    return;
  }

  const db = await initializeDatabase();
  try {
    const serviceResults: ImportServiceResult[] = [];
    const adoptable: Adoptable[] = [];

    for (const service of services) {
      const container = running.get(service);
      if (container === undefined) {
        serviceResults.push({ service, classification: "absent", imported: false });
        continue;
      }
      if (getDeploymentCount(db, { service }) > 0) {
        serviceResults.push({ service, classification: "tracked", container, imported: false });
        continue;
      }
      const captured = await captureRuntimeBaseline(container, { cwd: process.cwd(), envTool });
      if (captured === undefined) {
        serviceResults.push({
          service,
          classification: "uninspectable",
          container,
          imported: false,
          reason: "container inspection failed",
        });
        continue;
      }
      const serviceResult: ImportServiceResult = {
        service,
        classification: "candidate",
        container,
        imageTag: captured.identity.configuredImage,
        imageId: captured.identity.localImageId,
        imageDigest: captured.identity.repositoryDigest,
        imported: false,
      };
      serviceResults.push(serviceResult);
      adoptable.push({ result: serviceResult, captured });
    }

    // Preview: never writes.
    if (!willAdopt) {
      await emit(
        buildResult("preview", project, finalConfig.composePath, serviceResults, 0),
        format,
        showTracked,
      );
      return;
    }

    // Adopt: nothing to write.
    if (adoptable.length === 0) {
      await emit(
        buildResult("adopt", project, finalConfig.composePath, serviceResults, 0),
        format,
        showTracked,
      );
      return;
    }

    // Confirm before writing (text/interactive only; machine format required --yes above).
    if (!yes && format === "text") {
      const names = adoptable.map((candidate) => candidate.result.service).join(", ");
      const approved = await confirm(
        `Adopt ${adoptable.length} running service(s) into rfapps state tracking: ${names}? ` +
          "This records a baseline snapshot; compose.yml is not modified.",
      );
      if (!approved) {
        logWarn("Import cancelled; no baselines were written.");
        renderReport(
          buildResult("preview", project, finalConfig.composePath, serviceResults, 0),
          showTracked,
        );
        setExitCode(ExitCode.UsageError);
        return;
      }
    }

    // Single atomic batch. Candidates have no prior history (getDeploymentCount
    // === 0), so each baseline is that service's first generation (#1). Any
    // uninspectable service was already excluded and wrote no row, keeping it
    // importable on a later run.
    const timestamp = new Date().toISOString();
    const entries: StateEntryInput[] = adoptable.map((candidate) =>
      toBaselineEntry(candidate.result.service, candidate.captured, timestamp),
    );
    const ids = recordDeployments(db, entries);
    adoptable.forEach((candidate, index) => {
      candidate.result.imported = true;
      candidate.result.deploymentId = ids[index];
      candidate.result.generation = 1;
    });

    await emit(
      buildResult("adopt", project, finalConfig.composePath, serviceResults, adoptable.length),
      format,
      showTracked,
    );
  } finally {
    closeDatabase(db);
  }
}
