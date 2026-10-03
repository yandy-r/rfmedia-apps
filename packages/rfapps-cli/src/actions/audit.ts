/**
 * Security audit command action for rfapps CLI.
 *
 * Evaluates resolved Docker Compose configuration for advisory container
 * security posture findings. The action is read-only and does not mutate state.
 */

import { formatError, logDebug, outputFormattedError } from "@rfmedia/common";
import type { OutputFormat } from "@rfmedia/common";

import { formatOutput } from "../lib/formatters/index.js";
import { DockerCommandError, InvalidArgumentError } from "../lib/errors.js";
import {
  applyCliOverrides,
  evaluateSecurityAudit,
  formatAuditText,
  getComposeConfig,
  isValidProfile,
  loadConfig,
  parseAuditFailOn,
  resolveServicesWithInteractive,
  shouldFailAudit,
} from "../lib/index.js";
import { AUDIT_SCHEMA_VERSION } from "../types/audit.js";
import type { AuditComposeConfig, AuditOptions, AuditResult } from "../types/audit.js";
import { getEnvToolExecConfig } from "../types/index.js";

interface RawAuditOptions {
  service?: string;
  services?: string;
  group?: string;
  tag?: string[];
  sidecars?: boolean;
  failOn?: string;
  compose?: string;
  envFile?: string;
  profile?: string;
  json?: boolean;
}

function resolveAuditFormat(
  rawOptions: RawAuditOptions,
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

export async function executeAudit(
  rawOptions: RawAuditOptions,
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
  const envTool = getEnvToolExecConfig(globalOptions);
  const failOn = parseAuditFailOn(rawOptions.failOn);
  const options: AuditOptions = {
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
    failOn,
    output: resolveAuditFormat(rawOptions, globalOptions),
  };

  logDebug(`Audit options: ${JSON.stringify(options)}`);

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
  const targets = services.length > 0 ? services : undefined;
  const composeConfig = await getComposeConfig(finalConfig.composePath, {
    profiles,
    envFile: finalConfig.envFile,
    envTool,
  });

  if (composeConfig === undefined) {
    const error = new DockerCommandError(
      "config",
      "Failed to get compose config",
      1,
      services.length > 0 ? services : ["all"],
      false,
    );
    outputFormattedError(formatError(error));
    process.exitCode = 1;
    return;
  }

  const audit = evaluateSecurityAudit(composeConfig as unknown as AuditComposeConfig, targets);
  const result: AuditResult = {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    timestamp: audit.timestamp,
    scope: {
      services,
      profiles,
      composePath: finalConfig.composePath,
    },
    summary: audit.summary,
    findings: audit.findings,
  };

  if (shouldFailAudit(result, failOn)) {
    process.exitCode = 1;
  }

  if (options.output !== "text") {
    await formatOutput(options.output ?? "json", result);
    return;
  }

  for (const line of formatAuditText(result)) {
    console.error(line);
  }
}
