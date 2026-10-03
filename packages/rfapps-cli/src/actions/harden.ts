/**
 * Compose security hardening action for rfapps CLI.
 *
 * Detects hardening opportunities in the resolved compose configuration and,
 * on request, writes them back either as a compose override fragment or as an
 * in-place edit of compose.yml. Propose mode writes nothing.
 */

import { chmod, copyFile, readFile, rename, rm, stat, writeFile } from "node:fs/promises";

import {
  confirm,
  formatDryRun,
  formatError,
  isMachineFormat,
  logDebug,
  logInfo,
  outputFormattedError,
} from "@rfmedia/common";
import type { OutputFormat } from "@rfmedia/common";

import { validateHardenOptions } from "../commands/harden.js";
import { hasCode } from "../lib/backup-storage-shared.js";
import { DockerCommandError, InvalidArgumentError } from "../lib/errors.js";
import { ExitCode, setExitCode, setHardenExitCode } from "../lib/exit-codes.js";
import { formatOutput } from "../lib/formatters/index.js";
import {
  applyCliOverrides,
  applyHardenPatches,
  buildHardenOverride,
  buildHardenSummary,
  detectReformat,
  evaluateHardening,
  filterWritableProposals,
  formatHardenRulesCatalog,
  formatHardenText,
  getComposeConfig,
  isValidProfile,
  loadConfig,
  normalizeHardenSuppressions,
  parseHardenRuleIds,
  resolveServicesWithInteractive,
} from "../lib/index.js";
import { HARDEN_SCHEMA_VERSION } from "../types/hardening.js";
import type {
  HardenComposeConfig,
  HardenMode,
  HardenOptions,
  HardenResult,
  HardenWriteOutcome,
} from "../types/hardening.js";
import { getEnvToolExecConfig } from "../types/index.js";

/** Raw Commander option values for `rfapps harden`. */
export interface RawHardenOptions {
  /** Target a specific service. */
  readonly service?: string;
  /** Comma-separated service targets. */
  readonly services?: string;
  /** Target a service group. */
  readonly group?: string;
  /** Narrow the target set by hierarchical tag pattern; one entry per `--tag`. */
  readonly tag?: string[];
  /** Commander negation of `--no-sidecars`; `false` means the flag was passed. */
  readonly sidecars?: boolean;
  /** Edit compose.yml in place. */
  readonly apply?: boolean;
  /** Write a compose override fragment to this path. */
  readonly out?: string;
  /** Make review-confidence proposals eligible for writing. */
  readonly includeReview?: boolean;
  /** Comma-separated rule allowlist. */
  readonly rule?: string;
  /** Print the rule catalog and exit. */
  readonly listRules?: boolean;
  /** Commander negation of `--no-backup`; `false` means the flag was passed. */
  readonly backup?: boolean;
  /** Accept incidental YAML reformatting of untouched lines under `--apply`. */
  readonly allowReformat?: boolean;
  /** Path to the Docker Compose file. */
  readonly compose?: string;
  /** Path to the environment file. */
  readonly envFile?: string;
  /** Docker Compose profile to resolve with. */
  readonly profile?: string;
  /** Command-local JSON output flag. */
  readonly json?: boolean;
}

/** Program-level options harden reads. Mirrors `BackupGlobalOptions`. */
export interface HardenGlobalOptions {
  /** Preview actions without writing. */
  readonly dryRun?: boolean;
  /** Enable debug output. */
  readonly debug?: boolean;
  /** Program-level JSON output flag. */
  readonly json?: boolean;
  /** Program-level structured output format. */
  readonly output?: OutputFormat;
  /** Enable verbose output. */
  readonly verbose?: boolean;
  /** Skip confirmation prompts. */
  readonly yes?: boolean;
  /** Path to env file for dotenvx secrets injection. */
  readonly useDotenvx?: string;
  /** Path to env file for 1Password CLI secrets injection. */
  readonly useOp?: string;
}

function resolveHardenFormat(
  rawOptions: RawHardenOptions,
  globalOptions: HardenGlobalOptions,
): OutputFormat {
  // Command-local --json is checked first because cli.ts defaults the global
  // --output to "text", so globalOptions.output is never undefined and an
  // audit.ts-ordered check would make this flag permanently dead.
  if (rawOptions.json === true) {
    return "json";
  }
  if (globalOptions.output !== undefined) {
    return globalOptions.output;
  }
  if (globalOptions.json === true) {
    return "json";
  }
  return "text";
}

/**
 * Evaluate compose hardening and, when a write flag is present, persist it.
 *
 * Every mode evaluates the same proposals and computes the same patch set, so
 * propose reports exactly the refusals `--apply` would hit. Usage problems
 * throw {@link InvalidArgumentError}; operational failures are formatted
 * locally and reported through `process.exitCode`.
 *
 * @param rawOptions - Raw Commander option values for `rfapps harden`
 * @param globalOptions - Program-level options (`--dry-run`, `--yes`, `--output`, ...)
 * @throws {InvalidArgumentError} On usage errors, unknown rule ids, or a refused reformat
 */
export async function executeHarden(
  rawOptions: RawHardenOptions,
  globalOptions: HardenGlobalOptions,
): Promise<void> {
  const format = resolveHardenFormat(rawOptions, globalOptions);
  validateHardenOptions(rawOptions, globalOptions);

  if (rawOptions.listRules === true) {
    for (const line of formatHardenRulesCatalog()) {
      console.error(line);
    }
    return;
  }

  const mode: HardenMode =
    rawOptions.apply === true ? "apply" : rawOptions.out !== undefined ? "override" : "propose";

  const config = await loadConfig();
  if (rawOptions.profile !== undefined && !isValidProfile(rawOptions.profile, config)) {
    throw new InvalidArgumentError("--profile", rawOptions.profile, "Invalid profile", [
      ...config.profiles.validProfiles,
    ]);
  }

  const finalConfig = applyCliOverrides(config, {
    composePath: rawOptions.compose,
    envFile: rawOptions.envFile,
    profile: rawOptions.profile,
    noSidecars: rawOptions.sidecars === false,
  });
  const envTool = getEnvToolExecConfig(globalOptions, finalConfig);

  const includeReview =
    rawOptions.includeReview === true || (finalConfig.harden?.includeReview ?? false);
  const backup = rawOptions.backup !== false && (finalConfig.harden?.backup ?? true);
  const rules = parseHardenRuleIds(rawOptions.rule) ?? finalConfig.harden?.rules;
  const suppressions = normalizeHardenSuppressions(finalConfig.harden?.ignore ?? []);

  const options: HardenOptions = {
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
    apply: rawOptions.apply === true,
    overridePath: rawOptions.out,
    includeReview,
    rules,
    backup,
    allowReformat: rawOptions.allowReformat === true,
    output: format,
  };
  logDebug(`Harden options: ${JSON.stringify(options)}`);

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
    setExitCode(ExitCode.OperationalError);
    return;
  }

  const { proposals, suppressed } = evaluateHardening(
    composeConfig as unknown as HardenComposeConfig,
    targets,
    { suppressions, rules },
  );
  const timestamp = new Date().toISOString();
  const source = await readFile(finalConfig.composePath, "utf8");
  const reformat = detectReformat(source);
  const writable = filterWritableProposals(proposals, includeReview);
  const patched = applyHardenPatches(source, writable);
  const overrideDoc = buildHardenOverride(writable, {
    composePath: finalConfig.composePath,
    timestamp,
    includeReview,
  });

  let write: HardenWriteOutcome = { mode: "propose" };
  let patchesWritten = 0;

  if (mode === "override") {
    const overridePath = rawOptions.out as string;
    if (overrideDoc.content === "") {
      logInfo(`No writable patches; nothing written to ${overridePath}`);
      write = { mode: "override", path: overridePath, patchesWritten: 0 };
    } else if (options.dryRun) {
      logInfo(formatDryRun(`write compose override fragment to ${overridePath}`));
      write = { mode: "override", path: overridePath, patchesWritten: 0 };
    } else {
      try {
        await writeFile(overridePath, overrideDoc.content, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if (hasCode(error, "EEXIST")) {
          throw new InvalidArgumentError("--out", overridePath, "file already exists");
        }
        const message = error instanceof Error ? error.message : String(error);
        outputFormattedError(
          formatError(new DockerCommandError("harden", message, 1, services, false)),
        );
        setExitCode(ExitCode.OperationalError);
        return;
      }
      patchesWritten = overrideDoc.patchesWritten;
      write = { mode: "override", path: overridePath, patchesWritten };
    }
  } else if (mode === "apply") {
    const composePath = finalConfig.composePath;
    if (writable.length === 0) {
      logInfo("No writable patches; compose.yml unchanged");
      write = { mode: "apply", path: composePath, patchesWritten: 0, servicesPatched: [] };
    } else if (options.dryRun) {
      logInfo(
        formatDryRun(
          `apply ${patched.patchesWritten} hardening patch(es) to ${patched.servicesPatched.length} service(s) in ${composePath}`,
        ),
      );
      write = { mode: "apply", path: composePath, patchesWritten: 0, servicesPatched: [] };
    } else {
      if (reformat.wouldReformat && !options.allowReformat) {
        throw new InvalidArgumentError(
          "--apply",
          "true",
          `writing compose.yml would also reformat lines this command did not target (line delta: ${reformat.lineDelta}); re-run with --allow-reformat to accept, or use --out for a non-destructive override`,
        );
      }
      if (!options.yes && !isMachineFormat(format)) {
        const confirmed = await confirm(
          `Apply ${patched.patchesWritten} hardening patch(es) to ${patched.servicesPatched.length} service(s) in ${composePath}?`,
        );
        if (!confirmed) {
          logInfo("Cancelled");
          return;
        }
      }
      const backupPath = `${composePath}.bak`;
      const tempPath = `${composePath}.harden.tmp`;
      try {
        if (backup) {
          await copyFile(composePath, backupPath);
        }
        // rename() within one directory is atomic, so compose.yml is either the
        // original or the fully patched file and never a truncated mix.
        const { mode } = await stat(composePath);
        await writeFile(tempPath, patched.content, "utf8");
        await chmod(tempPath, mode);
        await rename(tempPath, composePath);
      } catch (error) {
        await rm(tempPath, { force: true });
        const message = error instanceof Error ? error.message : String(error);
        outputFormattedError(
          formatError(
            new DockerCommandError(
              "harden",
              `${message}; ${composePath} was not modified`,
              1,
              [...patched.servicesPatched],
              false,
            ),
          ),
        );
        setExitCode(ExitCode.OperationalError);
        return;
      }
      patchesWritten = patched.patchesWritten;
      write = {
        mode: "apply",
        path: composePath,
        ...(backup ? { backupPath } : {}),
        patchesWritten,
        servicesPatched: patched.servicesPatched,
      };
    }
  }

  const result: HardenResult = {
    schemaVersion: HARDEN_SCHEMA_VERSION,
    timestamp,
    mode,
    includeReview,
    scope: { services, profiles, composePath: finalConfig.composePath },
    summary: buildHardenSummary(proposals, suppressed, patchesWritten, patched.refusals),
    proposals,
    refusals: patched.refusals,
    reformat,
    override: overrideDoc.content,
    write,
  };

  if (format !== "text") {
    await formatOutput(format, result);
  } else {
    for (const line of formatHardenText(result)) {
      console.error(line);
    }
  }

  setHardenExitCode(result);
}
