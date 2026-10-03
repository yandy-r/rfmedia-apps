/**
 * Lint command action for rfapps CLI.
 *
 * Evaluates resolved Docker Compose configuration against production-readiness
 * rules and optionally compares running containers for runtime drift.
 */

import {
  colors,
  formatError,
  isMachineFormat,
  logDebug,
  outputFormattedError,
} from "@rfmedia/common";
import type { OutputFormat } from "@rfmedia/common";

import { setLintExitCode } from "../lib/exit-codes.js";
import { detectDrift } from "../lib/drift.js";
import {
  getComposeConfig,
  getRunningServiceContainerMap,
  inspectContainers,
} from "../lib/docker.js";
import { DockerCommandError, InvalidArgumentError } from "../lib/errors.js";
import { classifyFindingGroupFromSeverity } from "../lib/lint-context.js";
import {
  evaluateLint,
  filterFindingsByIgnore,
  LINT_RULES,
  RUNTIME_DRIFT_RULES,
} from "../lib/lint.js";
import { toSarif } from "../lib/lint-sarif.js";
import {
  applyCliOverrides,
  isValidProfile,
  loadConfig,
  resolveServicesWithInteractive,
} from "../lib/index.js";
import { formatOutput } from "../lib/formatters/index.js";
import type {
  DriftCategory,
  LintComposeConfig,
  LintFailOn,
  LintFinding,
  LintFindingGroup,
  LintIgnoreEntry,
  LintResult,
  LintRuleId,
  LintSeverity,
  LintSummary,
} from "../types/index.js";
import { getEnvToolExecConfig } from "../types/index.js";

interface RawLintOptions {
  service?: string;
  services?: string;
  group?: string;
  tag?: string[];
  sidecars?: boolean;
  compose?: string;
  envFile?: string;
  profile?: string;
  json?: boolean;
  sarif?: boolean;
  runtime?: boolean;
  listRules?: boolean;
  failOn?: string;
}

type LintOutputFormat = OutputFormat | "sarif";

const VALID_FAIL_ON: readonly LintFailOn[] = ["none", "info", "warn", "error"];

/**
 * Validates and normalizes the --fail-on CLI option.
 *
 * @throws {InvalidArgumentError} When the value is not a recognized severity threshold
 */
function parseFailOn(value: string | undefined): LintFailOn {
  if (value === undefined) {
    return "error";
  }

  const normalized = value.toLowerCase().trim();
  if (VALID_FAIL_ON.includes(normalized as LintFailOn)) {
    return normalized as LintFailOn;
  }

  throw new InvalidArgumentError("--fail-on", value, "Invalid fail-on severity", [
    ...VALID_FAIL_ON,
  ]);
}

function driftCategoryToRuleId(category: DriftCategory): LintRuleId {
  return `runtime-drift-${category}` as LintRuleId;
}

const LINT_SARIF_RULES = [...LINT_RULES, ...RUNTIME_DRIFT_RULES];

function resolveLintFormat(
  rawOptions: RawLintOptions,
  globalOptions: { json?: boolean; output?: OutputFormat },
): LintOutputFormat {
  if (rawOptions.sarif === true) {
    return "sarif";
  }
  if (rawOptions.json === true || globalOptions.json === true) {
    return "json";
  }
  return globalOptions.output ?? "text";
}

function severityColor(severity: LintSeverity): (value: string) => string {
  switch (severity) {
    case "error":
      return colors.red;
    case "warn":
      return colors.yellow;
    case "info":
      return colors.gray;
    default: {
      const exhaustive: never = severity;
      return exhaustive;
    }
  }
}

function buildSummary(findings: LintFinding[]): LintSummary {
  const summary: LintSummary = { error: 0, warn: 0, info: 0, total: findings.length };

  for (const finding of findings) {
    summary[finding.severity] += 1;
  }

  return summary;
}

function sortFindings(findings: LintFinding[]): LintFinding[] {
  return findings.slice().sort((left, right) => {
    const serviceCompare = left.service.localeCompare(right.service);
    if (serviceCompare !== 0) {
      return serviceCompare;
    }
    return left.ruleId.localeCompare(right.ruleId);
  });
}

const LINT_ADVISORY_BANNER =
  'Findings are advisory. Items under "Optional hardening" may not suit every workload — review before changing compose. Suppress known exceptions via `.rfapps.yaml` `lint.ignore`.';

const LINT_CATALOG_ADVISORY =
  "Info-level rules are optional hardening — review workload fit before applying.";

function displayLintRulesCatalog(): void {
  console.error(colors.bold("Production Readiness Lint Rules"));
  for (const rule of LINT_RULES) {
    console.error(`${rule.id} | ${rule.severity} | ${rule.rationale}`);
  }
  console.error(colors.gray(LINT_CATALOG_ADVISORY));
}

function displayFindingsForGroup(
  findings: LintFinding[],
  group: LintFindingGroup,
  sectionTitle: string,
): void {
  const groupFindings = findings.filter((finding) => finding.group === group);
  if (groupFindings.length === 0) {
    return;
  }

  const findingsByService = new Map<string, LintFinding[]>();
  for (const finding of groupFindings) {
    const existing = findingsByService.get(finding.service);
    if (existing !== undefined) {
      existing.push(finding);
      continue;
    }
    findingsByService.set(finding.service, [finding]);
  }

  console.error("");
  console.error(`  ${colors.bold(sectionTitle)}`);

  for (const [service, serviceFindings] of [...findingsByService.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    console.error("");
    console.error(`    ${colors.bold(service)}`);
    for (const finding of serviceFindings) {
      const color = severityColor(finding.severity);
      console.error(
        `      ${color(finding.severity.padEnd(5))}  ${finding.ruleId.padEnd(24)}  ${finding.message}  -> ${finding.remediation}`,
      );
      if (finding.contextNote !== undefined) {
        console.error(`        ${colors.gray(`note: ${finding.contextNote}`)}`);
      }
    }
  }
}

function displayLintResult(result: LintResult, serviceCount: number): void {
  console.error(colors.bold("Production Readiness Lint"));
  console.error(
    `  Services: ${serviceCount} | error ${result.summary.error} | warn ${result.summary.warn} | info ${result.summary.info}`,
  );

  if (result.findings.length === 0) {
    console.error(colors.green("  No findings"));
    return;
  }

  const hasReviewFirst = result.findings.some((finding) => finding.group === "review_first");
  if (hasReviewFirst) {
    console.error("");
    console.error(`  ${colors.gray(LINT_ADVISORY_BANNER)}`);
  }

  displayFindingsForGroup(result.findings, "recommended", "Recommended");
  displayFindingsForGroup(result.findings, "review_first", "Optional hardening (review first)");
}

function mapDriftToLintFindings(
  services: Array<{
    service: string;
    hasDrift: boolean;
    categories: DriftCategory[];
    direction: string;
  }>,
): LintFinding[] {
  const findings: LintFinding[] = [];

  for (const serviceDrift of services) {
    if (!serviceDrift.hasDrift) {
      continue;
    }

    for (const category of serviceDrift.categories) {
      const ruleId = driftCategoryToRuleId(category);
      findings.push({
        ruleId,
        service: serviceDrift.service,
        severity: "warn",
        message: `Runtime drift in ${category} (${serviceDrift.direction.replace(/_/g, " ")})`,
        remediation: `Run \`rfapps drift detect -s ${serviceDrift.service}\` for details, then reconcile or redeploy.`,
        group: classifyFindingGroupFromSeverity("warn"),
      });
    }
  }

  return findings;
}

async function appendRuntimeDriftFindings(
  result: LintResult,
  options: {
    composePath: string;
    services: string[];
    profiles: string[];
  },
  ignoreEntries: LintIgnoreEntry[],
  envTool: ReturnType<typeof getEnvToolExecConfig>,
): Promise<LintResult> {
  const serviceContainerMap = await getRunningServiceContainerMap(options.composePath, {
    profiles: options.profiles,
    envTool,
  });

  const containerNames =
    serviceContainerMap !== undefined ? [...new Set(serviceContainerMap.values())] : [];

  if (containerNames.length > 0) {
    const containerInspects = await inspectContainers(containerNames, { envTool });
    if (containerInspects === undefined) {
      throw new DockerCommandError(
        "inspect",
        "Failed to inspect containers for runtime lint",
        1,
        options.services.length > 0 ? options.services : ["all"],
        false,
      );
    }
  }

  const driftResult = await detectDrift(
    {
      composePath: options.composePath,
      services: options.services.length > 0 ? options.services : undefined,
      profiles: options.profiles,
    },
    envTool,
  );

  if (driftResult === undefined) {
    throw new DockerCommandError(
      "inspect",
      "Failed to detect runtime drift",
      1,
      options.services.length > 0 ? options.services : ["all"],
      false,
    );
  }

  const runtimeFindings = filterFindingsByIgnore(
    mapDriftToLintFindings(driftResult.services),
    ignoreEntries,
  );
  const findings = sortFindings([...result.findings, ...runtimeFindings]);

  return {
    ...result,
    findings,
    summary: buildSummary(findings),
    mode: "runtime",
  };
}

/**
 * Execute the lint command.
 *
 * Statically evaluates resolved compose configuration against production-readiness
 * rules. With `--runtime`, also compares running containers for configuration drift.
 */
export async function executeLint(
  rawOptions: RawLintOptions,
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
  const format = resolveLintFormat(rawOptions, globalOptions);
  const failOn = parseFailOn(rawOptions.failOn);

  if (rawOptions.listRules === true) {
    displayLintRulesCatalog();
    return;
  }

  const options = {
    service: rawOptions.service,
    services: rawOptions.services?.split(",").map((service) => service.trim()),
    group: rawOptions.group,
    tag: rawOptions.tag,
    noSidecars: rawOptions.sidecars === false,
    runtime: rawOptions.runtime ?? false,
    composePath: rawOptions.compose,
    envFile: rawOptions.envFile,
    profile: rawOptions.profile,
  };

  logDebug(`Lint options: ${JSON.stringify(options)}`);

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

  const envTool = getEnvToolExecConfig(globalOptions, finalConfig);

  const resolved = await resolveServicesWithInteractive(
    {
      service: options.service,
      services: options.services,
      group: options.group,
      tag: options.tag,
      noSidecars: options.noSidecars,
      sidecars: options.noSidecars === true ? false : undefined,
      yes: globalOptions.yes ?? false,
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

  const lintConfig = composeConfig as unknown as LintComposeConfig;
  const ignoreEntries = (finalConfig.lint?.ignore ?? []) as LintIgnoreEntry[];

  let result = evaluateLint(lintConfig, targets, ignoreEntries);

  if (options.runtime) {
    try {
      result = await appendRuntimeDriftFindings(
        result,
        {
          composePath: finalConfig.composePath,
          services: services.length > 0 ? services : [],
          profiles,
        },
        ignoreEntries,
        envTool,
      );
    } catch (error) {
      if (error instanceof DockerCommandError) {
        outputFormattedError(formatError(error));
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  }

  if (format === "sarif") {
    process.stdout.write(
      `${JSON.stringify(toSarif(result, LINT_SARIF_RULES, finalConfig.composePath), null, 2)}\n`,
    );
    setLintExitCode(result, failOn);
    return;
  }

  if (format !== "text") {
    await formatOutput(format, result);
    setLintExitCode(result, failOn);
    return;
  }

  if (!isMachineFormat(format)) {
    const serviceCount = targets?.length ?? Object.keys(lintConfig.services).length;
    displayLintResult(result, serviceCount);
  }

  setLintExitCode(result, failOn);
}
