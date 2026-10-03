/**
 * Doctor command action for rfapps CLI.
 *
 * Aggregates read-only diagnostic checks into one stable human/JSON surface.
 */

import { logDebug } from "@rfmedia/common";
import type { OutputFormat } from "@rfmedia/common";

import { formatOutput } from "../lib/formatters/index.js";
import { InvalidArgumentError } from "../lib/errors.js";
import {
  applyCliOverrides,
  buildDoctorSummary,
  formatDoctorText,
  isValidProfile,
  loadConfig,
  parseDoctorFailOn,
  resolveServicesWithInteractive,
  runDoctorChecks,
  shouldFailDoctor,
  sortDoctorFindings,
} from "../lib/index.js";
import { DOCTOR_SCHEMA_VERSION } from "../types/doctor.js";
import type { DoctorOptions, DoctorResult } from "../types/doctor.js";
import { getEnvToolExecConfig } from "../types/index.js";

interface RawDoctorOptions {
  service?: string;
  services?: string;
  group?: string;
  tag?: string[];
  sidecars?: boolean;
  checkUpdates?: boolean;
  failOn?: string;
  compose?: string;
  envFile?: string;
  profile?: string;
  json?: boolean;
}

function resolveDoctorFormat(
  rawOptions: RawDoctorOptions,
  globalOptions: { json?: boolean; output?: OutputFormat },
): OutputFormat {
  if (globalOptions.output !== undefined) {
    return globalOptions.output;
  }

  if (rawOptions.json === true || globalOptions.json === true) {
    return "json";
  }

  return "text";
}

export async function executeDoctor(
  rawOptions: RawDoctorOptions,
  globalOptions: {
    dryRun?: boolean;
    debug?: boolean;
    json?: boolean;
    output?: OutputFormat;
    verbose?: boolean;
    yes?: boolean;
    useDotenvx?: string;
    useOp?: string;
  },
): Promise<void> {
  const failOn = parseDoctorFailOn(rawOptions.failOn);
  const options: DoctorOptions = {
    dryRun: globalOptions.dryRun ?? false,
    debug: globalOptions.debug ?? false,
    json: globalOptions.json ?? false,
    verbose: globalOptions.verbose ?? false,
    yes: globalOptions.yes ?? false,
    useDotenvx: globalOptions.useDotenvx,
    useOp: globalOptions.useOp,
    service: rawOptions.service,
    services: rawOptions.services?.split(",").map((service) => service.trim()),
    group: rawOptions.group,
    tag: rawOptions.tag,
    noSidecars: rawOptions.sidecars === false,
    composePath: rawOptions.compose,
    envFile: rawOptions.envFile,
    profile: rawOptions.profile,
    checkUpdates: rawOptions.checkUpdates ?? false,
    failOn,
    output: resolveDoctorFormat(rawOptions, globalOptions),
  };

  logDebug(`Doctor options: ${JSON.stringify(options)}`);

  const config = await loadConfig();
  if (options.profile !== undefined && !isValidProfile(options.profile, config)) {
    throw new InvalidArgumentError("--profile", options.profile, "Invalid profile", [
      ...config.profiles.validProfiles,
    ]);
  }

  const finalConfig = applyCliOverrides(config, {
    composePath: options.composePath,
    envFile: options.envFile,
    profile: options.profile,
    noSidecars: options.noSidecars,
  });

  const envTool = getEnvToolExecConfig(globalOptions, finalConfig);

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
    return;
  }

  const { services, profiles } = resolved;
  const checkerResult = await runDoctorChecks({
    config: finalConfig,
    composePath: finalConfig.composePath,
    services,
    profiles,
    projectDir: process.cwd(),
    checkUpdates: options.checkUpdates,
    envTool,
  });
  const findings = sortDoctorFindings(checkerResult.findings);
  const warnings = checkerResult.warnings ?? [];

  const result: DoctorResult = {
    schemaVersion: DOCTOR_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    scope: {
      services,
      profiles,
      composePath: finalConfig.composePath,
      checkUpdates: options.checkUpdates,
    },
    summary: buildDoctorSummary(findings),
    checks: checkerResult.checks,
    findings,
    warnings: warnings.length > 0 ? warnings : undefined,
  };

  if (shouldFailDoctor(result, failOn)) {
    process.exitCode = 1;
  }

  if (options.output !== "text") {
    await formatOutput(options.output ?? "json", result);
    return;
  }

  for (const line of formatDoctorText(result)) {
    console.error(line);
  }
}
