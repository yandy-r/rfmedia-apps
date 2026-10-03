/**
 * Plan command action for rfapps CLI
 *
 * Generates a deployment plan showing what will change when deploying.
 * Similar to Terraform's plan/apply workflow.
 */

import {
  logInfo,
  logSuccess,
  logDebug,
  formatDryRun,
  colors,
  formatError,
  outputFormattedError,
} from "@rfmedia/common";
import type { OutputFormat } from "@rfmedia/common";

import {
  formatOutput,
  formatChangeType,
  formatDiffValue,
  formatArrayDiff,
  formatServiceIntelligenceLines,
  formatPlanIntelligenceLines,
} from "../lib/formatters/index.js";

import type { ServiceChange, DeploymentPlan } from "../types/plan.js";
import type { PlanIntelligence } from "../types/plan-intelligence.js";
import type { ScanReport } from "../types/security-scan.js";
import { getEnvToolExecConfig } from "../types/index.js";

import {
  loadConfig,
  applyCliOverrides,
  isValidProfile,
  resolveServicesWithInteractive,
  getComposeConfig,
  resolveScanSettings,
  resolveScanTargets,
  runSecurityScan,
  formatScanText,
} from "../lib/index.js";

import { DockerCommandError, InvalidArgumentError } from "../lib/errors.js";
import { ExitCode, setExitCode, setScanExitCode } from "../lib/exit-codes.js";

import { generatePlan } from "../lib/plan-generator.js";
import { savePlan } from "../lib/plan-storage.js";
// Imported by path, never through `../lib/index.js`: the plan action's spec
// mocks that barrel wholesale, which would silently auto-mock the loader.
import { loadPlanBaseline } from "../lib/plan-baseline.js";

/**
 * Parse raw plan options from CLI
 */
interface RawPlanOptions {
  service?: string;
  services?: string;
  group?: string;
  tag?: string[];
  sidecars?: boolean;
  apply?: boolean;
  out?: string;
  showUnchanged?: boolean;
  checkUpdates?: boolean;
  explain?: boolean;
  scan?: boolean;
  scanner?: string;
  scanFailOn?: string;
  compose?: string;
  envFile?: string;
  profile?: string;
}

/**
 * Plan command options
 */
interface PlanOptions {
  dryRun: boolean;
  debug: boolean;
  json: boolean;
  verbose: boolean;
  yes: boolean;
  service?: string;
  services?: string[];
  group?: string;
  tag?: string[];
  noSidecars: boolean;
  apply: boolean;
  outputPath?: string;
  showUnchanged: boolean;
  checkUpdates: boolean;
  explain: boolean;
  scan: boolean;
  composePath?: string;
  envFile?: string;
  profile?: string;
}

/** Machine-format payload for `rfapps plan`. */
interface PlanOutputPayload {
  planPath: string;
  plan: DeploymentPlan;
  /**
   * Image vulnerability scan report, present only under `--scan`.
   *
   * Lives on the output envelope, never on `DeploymentPlan`: `savePlan`
   * JSON-stringifies the whole plan, so an embedded CVE verdict would decay on
   * disk and `rfapps apply <path>` days later would re-assert it as authoritative.
   */
  scan?: ScanReport;
}

/**
 * Drop `plan.intelligence` for the formats that flatten nested objects.
 *
 * Mirrors `deployResultForOutput`. `table` and `csv` flatten, so a nested
 * annotation payload would either be stringified into one truncated cell or
 * deepen `flattenObject`'s already-exceeded depth budget. JSON and YAML carry
 * the payload verbatim. This is not a fix for `--output csv`, which already
 * throws on `plan.summary`; it only guarantees no regression.
 *
 * `scan` is stripped for the same reason: a nested `ScanReport` is deeper than
 * `plan.intelligence` and would flatten into an unreadable cell.
 *
 * @param format - resolved output format
 * @param payload - the `{ planPath, plan, scan? }` envelope
 * @returns the payload, or a copy without `scan` and `plan.intelligence`
 */
function planResultForOutput(
  format: OutputFormat,
  payload: PlanOutputPayload,
): PlanOutputPayload | object {
  const flattens = format === "table" || format === "csv";
  if (!flattens) {
    return payload;
  }

  const { scan: _scan, ...rest } = payload;
  if (rest.plan.intelligence === undefined) {
    return rest;
  }

  const { intelligence: _intelligence, ...plan } = rest.plan;
  return { ...rest, plan };
}

/**
 * Display service change details
 */
function displayServiceChange(
  change: ServiceChange,
  verbose: boolean,
  intelligence: PlanIntelligence | undefined,
): void {
  const prefix = "  ";

  // Contextual annotations (--explain) lead the block: cause before effect.
  // Absent without --explain, so the default rendering is unchanged.
  for (const line of formatServiceIntelligenceLines(intelligence?.services[change.service], {
    verbose,
  })) {
    console.error(`${prefix}${line}`);
  }

  // In verbose mode, show all configuration (like Terraform)
  // In normal mode, show only what's changing

  // Image (always show if changed, or if verbose, or if update available)
  if (change.image.changed || verbose || change.image.updateAvailable === true) {
    let imageDisplay = formatDiffValue(change.image.current, change.image.desired);

    // Add update indicator if newer version is available
    if (change.image.updateAvailable === true) {
      imageDisplay += ` ${colors.yellow("(update available)")}`;
    }

    console.error(`${prefix}${colors.bold("image")}: ${imageDisplay}`);
  }

  // Environment variables
  const envToShow = verbose
    ? change.environment // Show all env vars in verbose mode
    : change.environment.filter((e) => e.changeType !== "unchanged"); // Only changes in normal mode

  if (envToShow.length > 0) {
    console.error(`${prefix}${colors.bold("environment")}:`);
    for (const env of envToShow) {
      const value = env.isSecret
        ? formatDiffValue(
            env.current !== undefined ? "********" : undefined,
            env.desired !== undefined ? "********" : undefined,
          )
        : formatDiffValue(env.current, env.desired);
      console.error(`${prefix}  ${env.name}: ${value}`);
    }
  }

  // Ports (show if changed, or if verbose and ports are defined)
  if (
    change.ports.changed ||
    (verbose && (change.ports.current !== undefined || change.ports.desired !== undefined))
  ) {
    const currentPorts = change.ports.current?.map(
      (p) => `${p.host ?? "*"}:${p.container}/${p.protocol}`,
    );
    const desiredPorts = change.ports.desired?.map(
      (p) => `${p.host ?? "*"}:${p.container}/${p.protocol}`,
    );
    const portLines = formatArrayDiff(currentPorts, desiredPorts);
    console.error(`${prefix}${colors.bold("ports")}:`);
    for (const line of portLines) {
      console.error(`${prefix}  ${line}`);
    }
  }

  // Volumes (show if changed, or if verbose and volumes are defined)
  if (
    change.volumes.changed ||
    (verbose && (change.volumes.current !== undefined || change.volumes.desired !== undefined))
  ) {
    const currentVolumes = change.volumes.current?.map(
      (v) => `${v.source}:${v.target}${v.readonly ? ":ro" : ""}`,
    );
    const desiredVolumes = change.volumes.desired?.map(
      (v) => `${v.source}:${v.target}${v.readonly ? ":ro" : ""}`,
    );
    const volumeLines = formatArrayDiff(currentVolumes, desiredVolumes);
    console.error(`${prefix}${colors.bold("volumes")}:`);
    for (const line of volumeLines) {
      console.error(`${prefix}  ${line}`);
    }
  }

  // Networks (show if changed, or if verbose and networks are defined)
  if (
    change.networks.changed ||
    (verbose && (change.networks.current !== undefined || change.networks.desired !== undefined))
  ) {
    const networkLines = formatArrayDiff(change.networks.current, change.networks.desired);
    console.error(`${prefix}${colors.bold("networks")}:`);
    for (const line of networkLines) {
      console.error(`${prefix}  ${line}`);
    }
  }
}

/**
 * Display the full plan
 */
function displayPlan(
  plan: DeploymentPlan,
  options: { showUnchanged: boolean; verbose: boolean },
): void {
  console.error("");
  console.error(colors.bold("Deployment Plan"));
  console.error(colors.dim(`Plan ID: ${plan.id}`));
  console.error(colors.dim(`Compose: ${plan.composePath}`));
  console.error("");

  // Group services by change type
  const servicesByType: Record<string, ServiceChange[]> = {
    create: [],
    recreate: [],
    update: [],
    delete: [],
    unchanged: [],
  };

  for (const service of plan.services) {
    const arr = servicesByType[service.changeType];
    if (arr !== undefined) {
      arr.push(service);
    }
  }

  // Display services by change type
  for (const changeType of ["create", "recreate", "update", "delete"]) {
    const services = servicesByType[changeType];
    if (services !== undefined && services.length > 0) {
      for (const service of services) {
        console.error(`${formatChangeType(changeType)} ${colors.bold(service.service)}`);
        displayServiceChange(service, options.verbose, plan.intelligence);
        console.error("");
      }
    }
  }

  // Optionally show unchanged services
  if (
    options.showUnchanged &&
    servicesByType["unchanged"] !== undefined &&
    servicesByType["unchanged"].length > 0
  ) {
    console.error(colors.dim("Unchanged services:"));
    for (const service of servicesByType["unchanged"]) {
      console.error(`  ${colors.dim(service.service)}`);
    }
    console.error("");
  }

  // Summary
  console.error(colors.bold("Summary:"));
  if (plan.summary.toCreate > 0) {
    console.error(`  ${colors.green("+")} ${plan.summary.toCreate} to create`);
  }
  if (plan.summary.toRecreate > 0) {
    console.error(`  ${colors.cyan("~")} ${plan.summary.toRecreate} to recreate`);
  }
  if (plan.summary.toUpdate > 0) {
    console.error(`  ${colors.yellow("!")} ${plan.summary.toUpdate} to update`);
  }
  if (plan.summary.toDelete > 0) {
    console.error(`  ${colors.red("-")} ${plan.summary.toDelete} to delete`);
  }
  console.error(`  ${colors.dim("=")} ${plan.summary.unchanged} unchanged`);
  if (plan.summary.updatesAvailable > 0) {
    console.error(
      `  ${colors.yellow("^")} ${plan.summary.updatesAvailable} update${plan.summary.updatesAvailable > 1 ? "s" : ""} available`,
    );
  }

  // Plan-level annotations (--explain): the downstream rollup line closes the
  // summary list, then the registry-drift section, change origin, and any
  // degraded banner. Empty without --explain. The renderer carries its own
  // indentation.
  for (const line of formatPlanIntelligenceLines(plan.intelligence, plan.services, {
    verbose: options.verbose,
  })) {
    console.error(line);
  }

  console.error("");
}

/**
 * Execute the plan command.
 *
 * Generates a deployment plan showing what changes would occur when deploying.
 * Similar to Terraform's plan/apply workflow, this allows previewing changes
 * before applying them.
 *
 * The plan compares:
 * - Current running containers (from docker inspect)
 * - Desired state (from compose.yml)
 *
 * And shows differences in: images, environment variables, ports, volumes, networks.
 *
 * Plans are saved to .rfapps/plans/ for later application via 'rfapps apply'.
 *
 * @param rawOptions - Command-specific options from CLI
 * @param globalOptions - Global CLI options (debug, json mode, secrets injection, etc.)
 *
 * @example
 * ```typescript
 * // Generate plan for all services
 * await executePlan({}, {});
 *
 * // Generate plan with update checking
 * await executePlan({ checkUpdates: true }, {});
 *
 * // Generate and immediately apply
 * await executePlan({ apply: true }, { yes: true });
 * ```
 */
export async function executePlan(
  rawOptions: RawPlanOptions,
  globalOptions: {
    dryRun?: boolean;
    debug?: boolean;
    json?: boolean;
    output?: import("@rfmedia/common").OutputFormat;
    verbose?: boolean;
    yes?: boolean;
    useDotenvx?: string;
    useOp?: string;
  },
): Promise<void> {
  // Extract env tool config from global options
  const envTool = getEnvToolExecConfig(globalOptions);

  // Build options
  const options: PlanOptions = {
    dryRun: globalOptions.dryRun ?? false,
    debug: globalOptions.debug ?? false,
    json: globalOptions.json ?? false,
    verbose: globalOptions.verbose ?? false,
    yes: globalOptions.yes ?? false,
    service: rawOptions.service,
    services: rawOptions.services?.split(",").map((s) => s.trim()),
    group: rawOptions.group,
    tag: rawOptions.tag,
    noSidecars: rawOptions.sidecars === false,
    apply: rawOptions.apply ?? false,
    outputPath: rawOptions.out,
    showUnchanged: rawOptions.showUnchanged ?? false,
    checkUpdates: rawOptions.checkUpdates ?? false,
    explain: rawOptions.explain ?? false,
    scan: rawOptions.scan ?? false,
    composePath: rawOptions.compose,
    envFile: rawOptions.envFile,
    profile: rawOptions.profile,
  };

  logDebug(`Plan options: ${JSON.stringify(options)}`);

  if (!options.scan && (rawOptions.scanner !== undefined || rawOptions.scanFailOn !== undefined)) {
    // Report the flag the operator actually typed.
    const suppliedFlag = rawOptions.scanner !== undefined ? "--scanner" : "--scan-fail-on";
    throw new InvalidArgumentError(
      suppliedFlag,
      String(rawOptions.scanner ?? rawOptions.scanFailOn),
      "Scan options require --scan",
    );
  }

  // Load configuration
  const config = await loadConfig();
  const finalConfig = applyCliOverrides(config, {
    composePath: options.composePath,
    envFile: options.envFile,
    profile:
      options.profile !== undefined && isValidProfile(options.profile, config)
        ? options.profile
        : undefined,
    noSidecars: options.noSidecars,
  });

  // Resolve services with interactive selection support
  const resolved = await resolveServicesWithInteractive(
    {
      service: options.service,
      services: options.services,
      group: options.group,
      tag: options.tag,
      noSidecars: options.noSidecars,
      sidecars: options.noSidecars === true ? false : undefined,
      yes: options.yes,
    },
    finalConfig,
    finalConfig.composePath,
    process.cwd(),
    { envTool },
  );

  if (resolved === null) {
    return; // User cancelled or no services selected
  }

  const { services, profiles } = resolved;

  logDebug(`Using profiles: ${profiles.join(", ")}`);
  logDebug(`Analyzing services: ${services.length > 0 ? services.join(", ") : "all"}`);

  // Dry run mode
  if (options.dryRun) {
    const serviceList = services.length > 0 ? services.join(", ") : "all services";
    logInfo(formatDryRun(`generate plan for: ${serviceList}`));
    return;
  }

  // Generate plan
  logInfo("Analyzing current state and generating plan...");

  // Baseline loading is filesystem I/O, so it runs only under --explain. The
  // spread below keeps the non-explain generator argument byte-identical: an
  // `intelligence: undefined` key would still be a key.
  const intelligence = options.explain
    ? {
        profileMapping: finalConfig.profiles?.mapping ?? {},
        baseline: await loadPlanBaseline(finalConfig.composePath, profiles),
      }
    : undefined;

  const plan = await generatePlan(
    {
      composePath: finalConfig.composePath,
      services: services.length > 0 ? services : undefined,
      profiles,
      checkUpdates: options.checkUpdates,
      ...(intelligence === undefined ? {} : { intelligence }),
    },
    envTool,
  );

  if (plan === undefined) {
    const error = new DockerCommandError(
      "plan",
      "Failed to generate deployment plan",
      1,
      services.length > 0 ? services : [],
      false,
    );
    const formatted = formatError(error);
    outputFormattedError(formatted);
    process.exitCode = 1;
    return;
  }

  // The scan runs after plan generation and before the plan is written: the
  // report is evidence for this invocation only. `--dry-run` short-circuits
  // before generation, so `plan --dry-run --scan` deliberately scans nothing.
  let scan: ScanReport | undefined;
  if (options.scan) {
    const settings = resolveScanSettings(rawOptions, finalConfig.scan, process.cwd());
    const composeConfig = await getComposeConfig(finalConfig.composePath, {
      profiles,
      envFile: finalConfig.envFile,
      envTool,
    });
    if (composeConfig === undefined) {
      const error = new DockerCommandError(
        "config",
        "Failed to resolve compose config for scanning",
        1,
        services.length > 0 ? services : ["all"],
        false,
      );
      outputFormattedError(formatError(error));
      setExitCode(ExitCode.OperationalError);
      return;
    }

    const { targets, skipped } = resolveScanTargets(composeConfig, services, settings.maxTargets);
    scan = await runSecurityScan(
      targets,
      skipped,
      { services, profiles, composePath: finalConfig.composePath },
      settings,
    );
  }

  // Save plan
  const planPath = await savePlan(plan, options.outputPath);
  logSuccess(`Plan saved to ${planPath}`);

  // Display plan
  const format = globalOptions.output ?? "text";
  if (format !== "text") {
    await formatOutput(
      format,
      planResultForOutput(format, {
        planPath,
        plan,
        ...(scan === undefined ? {} : { scan }),
      }),
    );
  } else {
    displayPlan(plan, { showUnchanged: options.showUnchanged, verbose: options.verbose });
    console.error(colors.dim(`Plan saved to: ${planPath}`));
    console.error("");
    console.error(`To apply this plan, run:`);
    console.error(`  ${colors.cyan(`rfapps apply ${planPath}`)}`);
    console.error("");
  }

  // `planResultForOutput` strips `scan` for table, so the report would otherwise
  // vanish while `setScanExitCode` still failed the run. Rendering here keeps the
  // text ordering identical: it was the last statement of the text branch.
  if (scan !== undefined && (format === "text" || format === "table")) {
    for (const line of formatScanText(scan)) {
      console.error(line);
    }
  }

  // The plan file is still written when the gate blocks: a plan is evidence, not
  // a mutation, and `rfapps apply <path>` remains the explicit operator override.
  if (scan !== undefined && scan.gate.blocking) {
    setScanExitCode(scan);
    return;
  }

  // Check if --apply flag is set
  if (options.apply) {
    // Import and execute apply
    const { executeApply } = await import("./apply.js");
    await executeApply({ planFile: planPath, force: false }, globalOptions);
  }
}
