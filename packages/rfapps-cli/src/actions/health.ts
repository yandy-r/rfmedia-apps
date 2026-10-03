/**
 * Health command action for rfapps CLI.
 *
 * Evaluates dependency readiness using container state/health and TCP probes.
 */

import {
  formatDryRun,
  formatError,
  isMachineFormat,
  logDebug,
  logInfo,
  logSuccess,
  logWarn,
  outputFormattedError,
} from "@rfmedia/common";
import type { OutputFormat } from "@rfmedia/common";

import { formatOutput } from "../lib/formatters/index.js";
import { DockerCommandError } from "../lib/errors.js";
import {
  applyCliOverrides,
  isValidProfile,
  loadConfig,
  resolveServicesWithInteractive,
  waitForDependencyReadiness,
} from "../lib/index.js";
import type { HealthCommandResult, HealthOptions } from "../types/index.js";
import { getEnvToolExecConfig } from "../types/index.js";

interface RawHealthOptions {
  service?: string;
  services?: string;
  group?: string;
  tag?: string[];
  sidecars?: boolean;
  waitForReady?: boolean;
  healthTimeout?: number | string;
  compose?: string;
  envFile?: string;
  profile?: string;
}

export async function executeHealth(
  rawOptions: RawHealthOptions,
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
  const options: HealthOptions = {
    dryRun: globalOptions.dryRun ?? false,
    debug: globalOptions.debug ?? false,
    json: globalOptions.json ?? false,
    verbose: globalOptions.verbose ?? false,
    yes: globalOptions.yes ?? false,
    service: rawOptions.service,
    services: rawOptions.services?.split(",").map((service) => service.trim()),
    group: rawOptions.group,
    tag: rawOptions.tag,
    noSidecars: rawOptions.sidecars === false,
    waitForReady: rawOptions.waitForReady ?? true,
    healthTimeout:
      typeof rawOptions.healthTimeout === "string"
        ? Number.parseInt(rawOptions.healthTimeout, 10)
        : (rawOptions.healthTimeout ?? 0),
    composePath: rawOptions.compose,
    envFile: rawOptions.envFile,
    profile: rawOptions.profile,
  };

  const format = globalOptions.output ?? "text";
  logDebug(`Health options: ${JSON.stringify(options)}`);

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

  const healthTimeout =
    Number.isFinite(options.healthTimeout) && options.healthTimeout > 0
      ? options.healthTimeout
      : finalConfig.healthCheck.timeout;
  const waitForReady = rawOptions.waitForReady ?? finalConfig.healthCheck.waitForReady;

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

  if (options.dryRun) {
    const serviceList = services.length > 0 ? services.join(", ") : "all services";
    const waitMode = waitForReady ? "wait for readiness" : "single readiness snapshot";
    logInfo(formatDryRun(`health check for ${serviceList} (${waitMode})`));

    if (format !== "text") {
      await formatOutput(format, {
        dryRun: true,
        services: services.length > 0 ? services : ["all"],
        profiles,
        composePath: finalConfig.composePath,
        waitForReady,
        healthTimeout,
      });
    }
    return;
  }

  let lastReadinessSignature = "";
  const summary = await waitForDependencyReadiness({
    composePath: finalConfig.composePath,
    targetServices: services,
    projectDir: process.cwd(),
    profiles,
    envTool,
    waitForReady,
    poll: {
      timeoutSeconds: healthTimeout,
      intervalSeconds: finalConfig.healthCheck.interval,
      retries: finalConfig.healthCheck.retries,
    },
    onProgress: isMachineFormat(format)
      ? undefined
      : (current) => {
          const waiting = [...current.pendingDependencies, ...current.failedDependencies];
          const signature = waiting.join(",");
          if (signature === lastReadinessSignature) {
            return;
          }

          lastReadinessSignature = signature;
          if (waiting.length > 0) {
            logInfo(`Dependencies pending readiness: ${waiting.join(", ")}`);
          } else if (current.ready) {
            logSuccess("Dependencies are ready");
          }
        },
  });

  if (summary.warnings !== undefined) {
    for (const warning of summary.warnings) {
      logWarn(warning);
    }
  }

  const result: HealthCommandResult = {
    services: summary.services.map((entry) => entry.service),
    ready: summary.ready,
    timedOut: summary.timedOut,
    totalDependencies: summary.totalDependencies,
    readyDependencies: summary.readyDependencies,
    pendingDependencies: summary.pendingDependencies,
    failedDependencies: summary.failedDependencies,
    attempts: summary.attempts,
    elapsedMs: summary.elapsedMs,
    details: summary.services,
    signalAvailability: summary.signalAvailability,
    warnings: summary.warnings,
  };

  const readinessUnavailable = summary.signalAvailability.available === false;

  if (waitForReady && !summary.ready && !readinessUnavailable) {
    const notReadyDependencies = [...summary.pendingDependencies, ...summary.failedDependencies];
    const error = new DockerCommandError(
      "health",
      `Dependencies not ready within timeout: ${notReadyDependencies.join(", ")}`,
      1,
      notReadyDependencies,
      false,
    );
    const formatted = formatError(error);
    outputFormattedError(formatted);
    process.exitCode = 1;
  } else if (!summary.ready && readinessUnavailable) {
    logWarn("Dependency readiness checks unavailable. Returning latest snapshot.");
  } else if (summary.ready) {
    logSuccess("All dependency checks passed");
  }

  if (format !== "text") {
    await formatOutput(format, result);
  }
}
