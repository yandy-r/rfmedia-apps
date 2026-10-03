/**
 * Operator boundary for report-first desired-versus-actual reconciliation.
 *
 * This action owns configuration, frozen scope selection, approval, signal
 * lifetime, rendering, and process exit state. The coordinator remains
 * data-only and is the only path to Docker mutation.
 */

import { dirname } from "node:path";

import { confirm, isMachineFormat, logDebug, type OutputFormat } from "@rfmedia/common";

import type { RfappsConfig } from "../types/config.js";
import type { EnvToolExecConfig } from "../types/options.js";
import type { ReconcileResult, ReconcileServiceResult } from "../types/reconcile.js";
import { getEnvToolExecConfig } from "../types/options.js";

import { applyCliOverrides, loadConfig } from "../lib/config.js";
import {
  type DockerExecOptions,
  getComposeConfig,
  getComposeServices,
  getRunningServiceContainerMap,
  inspectContainerIdentity,
  reconcileService,
} from "../lib/docker.js";
import { buildServiceDependencyGraph, topologicalSort } from "../lib/dependency-graph.js";
import { observeReconcileDrift } from "../lib/drift.js";
import { InvalidArgumentError } from "../lib/errors.js";
import { captureEffectiveEnvironment } from "../lib/env-tools.js";
import { formatOutput } from "../lib/formatters/index.js";
import { verifyServiceReadiness } from "../lib/health.js";
import {
  dockerAuthorityFingerprint,
  dockerAuthorityFingerprintFromEnvironment,
  resolveComposeEnvironmentFilePath,
  resolveComposeProjectIdentity,
  type ComposeProjectIdentity,
} from "../lib/identity.js";
import {
  resolveServicesWithInteractive,
  type ResolveServicesFn,
} from "../lib/interactive-selection.js";
import { acquireLifecycleLock } from "../lib/lifecycle-lock.js";
import { environmentSourceFingerprint } from "../lib/managed-update.js";
import { resolvedServiceConfigFingerprint } from "../lib/plan-generator.js";
import { hashFile } from "../lib/plan-storage.js";
import {
  allowAllReconcilePolicy,
  assertReconcileScopeServices,
  buildReconcilePlan,
  runReconcile,
  summarizeReconcileServices,
  type BuildReconcilePlanInput,
  type ReconcileCoordinatorDependencies,
} from "../lib/reconcile.js";
import {
  describeSelector,
  explicitSelectorFlagNames,
  hasExplicitSelector,
} from "../lib/selector.js";
import { isValidProfile } from "../lib/services.js";

export interface RawReconcileOptions {
  service?: string;
  services?: string;
  group?: string;
  /** Hierarchical tag patterns (`--tag`), one entry per occurrence. Never defaulted to `[]`. */
  tag?: string[];
  sidecars?: boolean;
  autoApply?: boolean;
  showUnchanged?: boolean;
  healthTimeout?: number | string;
  compose?: string;
  envFile?: string;
  profile?: string;
}

export interface ReconcileGlobalOptions {
  dryRun?: boolean;
  debug?: boolean;
  json?: boolean;
  output?: OutputFormat;
  verbose?: boolean;
  yes?: boolean;
  useDotenvx?: string;
  useOp?: string;
}

interface NormalizedReconcileOptions {
  service?: string;
  services?: string[];
  group?: string;
  /**
   * Carried verbatim from {@link RawReconcileOptions}. `ServiceTargetOptions`' fan-out
   * does NOT reach this interface — it is declared locally — so omitting it here leaves
   * `options.tag` permanently `undefined` and `reconcile --tag` declares the flag and
   * silently drops it on a mutating, lock-taking command.
   */
  tag?: string[];
  noSidecars: boolean;
  autoApply: boolean;
  showUnchanged: boolean;
  healthTimeout?: number;
  composePath?: string;
  envFile?: string;
  profile?: string;
  dryRun: boolean;
  yes: boolean;
  verbose: boolean;
  format: OutputFormat;
}

interface ResolvedReconcileServices {
  services: string[];
  profiles: string[];
}

interface ReconcileSignalTracker {
  getInterruption(): "SIGINT" | "SIGTERM" | undefined;
}

export interface ReconcileRuntimeContext {
  mode: "report" | "auto-apply";
  dryRun: boolean;
  scope: {
    composePath: string;
    project: string;
    profiles: string[];
    services: string[];
  };
  projectDir: string;
  envFile: string;
  envTool?: EnvToolExecConfig;
  config: RfappsConfig;
  healthPoll: {
    timeoutSeconds: number;
    intervalSeconds: number;
    retries: number;
  };
}

export interface ReconcileActionDependencies {
  loadConfig(): Promise<RfappsConfig>;
  applyCliOverrides: typeof applyCliOverrides;
  /**
   * The shared resolver seam. Declared through {@link ResolveServicesFn} rather than
   * re-stated structurally so a new targeting axis cannot be added here and forgotten in
   * `backup`/`update` — a missed copy typechecks and silently drops the axis.
   */
  resolveServices: ResolveServicesFn<ResolvedReconcileServices, { envTool?: EnvToolExecConfig }>;
  getComposeServices(
    composePath: string,
    options: {
      profiles?: string[];
      projectName?: string;
      envFile?: string;
      envTool?: EnvToolExecConfig;
    },
  ): Promise<string[]>;
  resolveComposeProjectIdentity(
    composePath: string,
    options: { envFile?: string; envTool?: EnvToolExecConfig },
  ): Promise<ComposeProjectIdentity>;
  resolveComposeEnvironmentFilePath(envFile: string): Promise<string>;
  captureSnapshot(context: ReconcileRuntimeContext): Promise<BuildReconcilePlanInput>;
  createCoordinatorDependencies(
    context: ReconcileRuntimeContext,
    signal: ReconcileSignalTracker,
  ): ReconcileCoordinatorDependencies;
  buildReconcilePlan(input: BuildReconcilePlanInput): ReconcileResult;
  runReconcile: typeof runReconcile;
  confirm(message: string): Promise<boolean>;
  formatOutput(format: OutputFormat, data: unknown): Promise<void>;
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(lexical);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Reject resolved models that would still make Compose reopen mutable authority files. */
export function resolvedComposeAuthorityBlockReason(
  composeConfig: unknown,
  serviceName: string,
): string | undefined {
  const root = asRecord(composeConfig);
  const services = asRecord(root?.["services"]);
  const service = asRecord(services?.[serviceName]);
  if (root === undefined || services === undefined || service === undefined) {
    return "RECONCILE_AUTHORITY_UNSNAPSHOTABLE";
  }

  for (const resourceType of ["configs", "secrets"] as const) {
    const references = service[resourceType];
    if (references === undefined) continue;
    if (!Array.isArray(references)) {
      return "RECONCILE_AUTHORITY_UNSNAPSHOTABLE";
    }
    const definitions = asRecord(root[resourceType]);
    for (const reference of references) {
      const source = typeof reference === "string" ? reference : asRecord(reference)?.["source"];
      if (typeof source !== "string" || source === "" || definitions === undefined) {
        return "RECONCILE_AUTHORITY_UNSNAPSHOTABLE";
      }
      const definition = asRecord(definitions[source]);
      if (
        definition === undefined ||
        typeof definition["file"] === "string" ||
        typeof definition["environment"] === "string"
      ) {
        return "RECONCILE_AUTHORITY_UNSNAPSHOTABLE";
      }
    }
  }
  return undefined;
}

function assertResolvedComposeAuthoritySnapshotable(
  composeConfig: unknown,
  serviceName: string,
): void {
  if (resolvedComposeAuthorityBlockReason(composeConfig, serviceName) !== undefined) {
    throw new Error("Resolved Compose authority contains unpinned external resources");
  }
}

function normalizeOptions(
  rawOptions: RawReconcileOptions,
  globalOptions: ReconcileGlobalOptions,
): NormalizedReconcileOptions {
  const timeout =
    typeof rawOptions.healthTimeout === "string"
      ? Number(rawOptions.healthTimeout)
      : rawOptions.healthTimeout;
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
    throw new InvalidArgumentError(
      "--health-timeout",
      String(rawOptions.healthTimeout),
      "Must be a positive number of seconds",
    );
  }

  const service = rawOptions.service?.trim();
  if (rawOptions.service !== undefined && service === "") {
    throw new InvalidArgumentError("--service", rawOptions.service, "Must name a service");
  }
  const group = rawOptions.group?.trim();
  if (rawOptions.group !== undefined && group === "") {
    throw new InvalidArgumentError("--group", rawOptions.group, "Must name a service group");
  }
  const services = rawOptions.services
    ?.split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  if (rawOptions.services !== undefined && services?.length === 0) {
    throw new InvalidArgumentError("--services", rawOptions.services, "Must name a service");
  }

  return {
    ...(service === undefined ? {} : { service }),
    ...(services === undefined ? {} : { services }),
    ...(group === undefined ? {} : { group }),
    ...(rawOptions.tag === undefined ? {} : { tag: rawOptions.tag }),
    noSidecars: rawOptions.sidecars === false,
    autoApply: rawOptions.autoApply ?? false,
    showUnchanged: rawOptions.showUnchanged ?? false,
    ...(timeout === undefined ? {} : { healthTimeout: timeout }),
    ...(rawOptions.compose === undefined ? {} : { composePath: rawOptions.compose }),
    ...(rawOptions.envFile === undefined ? {} : { envFile: rawOptions.envFile }),
    ...(rawOptions.profile === undefined ? {} : { profile: rawOptions.profile }),
    dryRun: globalOptions.dryRun ?? false,
    yes: globalOptions.yes ?? false,
    verbose: globalOptions.verbose ?? false,
    format: globalOptions.output ?? (globalOptions.json === true ? "json" : "text"),
  };
}

/**
 * Names the selector axis to blame when a frozen scope turns out to be unusable.
 *
 * Both halves are derived from `lib/selector.ts` rather than open-coded, so a new
 * targeting axis reports itself instead of being mislabelled `--service`. Taking the
 * **last** present axis reproduces the previous `--group` > `--services` > `--service`
 * precedence exactly — that is their declaration order in `SELECTOR_AXES` — and extends
 * it to `--tag`, which is the narrowing culprit whenever it is present.
 *
 * @param options - The normalized selector, in axis-declaration order
 * @param fallbackValue - Rendered value when no axis is present at all
 * @returns The `InvalidArgumentError` argument name and the selector the operator gave
 */
function selectorBlame(
  options: NormalizedReconcileOptions,
  fallbackValue: string,
): { argument: string; value: string } {
  const flags = explicitSelectorFlagNames(options);

  return {
    argument: flags[flags.length - 1] ?? "--service",
    value: describeSelector(options) || fallbackValue,
  };
}

async function captureProductionSnapshot(
  context: ReconcileRuntimeContext,
  pinnedExecution?: Pick<DockerExecOptions, "env" | "replaceEnv">,
): Promise<BuildReconcilePlanInput> {
  const execution = pinnedExecution ?? {};
  const envTool = pinnedExecution === undefined ? context.envTool : undefined;
  const composeOptions = {
    profiles: context.scope.profiles,
    projectName: context.scope.project,
    envFile: context.envFile,
    cwd: context.projectDir,
    ...execution,
    envTool,
  };
  const [composeFingerprint, dockerFingerprint, composeConfig, evidence] = await Promise.all([
    hashFile(context.scope.composePath),
    pinnedExecution?.env === undefined
      ? dockerAuthorityFingerprint(context.envTool)
      : dockerAuthorityFingerprintFromEnvironment(pinnedExecution.env),
    getComposeConfig(context.scope.composePath, composeOptions),
    observeReconcileDrift(
      {
        composePath: context.scope.composePath,
        services: context.scope.services,
        profiles: context.scope.profiles,
        projectName: context.scope.project,
        envFile: context.envFile,
        cwd: context.projectDir,
        ...execution,
      },
      envTool,
    ),
  ]);
  if (composeFingerprint === "" || composeConfig === undefined) {
    throw new Error("Unable to capture the resolved Compose authority for reconciliation");
  }

  const evidenceByService = new Map(evidence.map((entry) => [entry.service, entry]));
  return {
    mode: context.mode,
    dryRun: context.dryRun,
    scope: {
      ...context.scope,
      profiles: [...context.scope.profiles],
      services: [...context.scope.services],
    },
    authority: {
      composeFingerprint,
      resolvedComposeFingerprint: resolvedServiceConfigFingerprint(composeConfig),
      dockerAuthorityFingerprint: dockerFingerprint,
      environmentSourceFingerprint: environmentSourceFingerprint(
        context.envTool ?? { tool: "none", envFile: context.envFile },
      ),
    },
    services: context.scope.services.map((service) => {
      const entry = evidenceByService.get(service);
      const blockedReason = resolvedComposeAuthorityBlockReason(composeConfig, service);
      return {
        service,
        resolvedConfigFingerprint: resolvedServiceConfigFingerprint(
          composeConfig.services[service] ?? null,
        ),
        observation:
          blockedReason === undefined
            ? (entry?.observation ?? {
                kind: "failed",
                reasonCode: "RECONCILE_EVIDENCE_MISSING",
              })
            : { kind: "failed", reasonCode: blockedReason },
        ...(blockedReason !== undefined || entry?.drift === undefined
          ? {}
          : { drift: entry.drift }),
      };
    }),
  };
}

export function createProductionCoordinatorDependencies(
  context: ReconcileRuntimeContext,
  signal: ReconcileSignalTracker,
  executeTarget: typeof reconcileService = reconcileService,
  captureResolvedCompose: typeof getComposeConfig = getComposeConfig,
  captureEnvironment: typeof captureEffectiveEnvironment = captureEffectiveEnvironment,
): ReconcileCoordinatorDependencies {
  let pinnedExecution: Promise<{ env: Record<string, string>; replaceEnv: true }> | undefined;
  async function getPinnedExecution(): Promise<{ env: Record<string, string>; replaceEnv: true }> {
    if (pinnedExecution === undefined) {
      pinnedExecution = captureEnvironment({
        tool: context.envTool?.tool ?? "none",
        ...(context.envTool?.envFile === undefined ? {} : { envFile: context.envTool.envFile }),
        cwd: context.projectDir,
      }).then((env) => ({ env, replaceEnv: true as const }));
    }
    return pinnedExecution;
  }
  return {
    observation: {
      capture: async () => captureProductionSnapshot(context, await getPinnedExecution()),
    },
    order: {
      async phases(services) {
        const execution = await getPinnedExecution();
        const composeConfig = await getComposeConfig(context.scope.composePath, {
          profiles: context.scope.profiles,
          projectName: context.scope.project,
          envFile: context.envFile,
          cwd: context.projectDir,
          ...execution,
        });
        if (composeConfig === undefined) {
          throw new Error("Unable to resolve reconciliation dependency order");
        }
        const graph = topologicalSort(
          buildServiceDependencyGraph(composeConfig, context.config.sidecars.mapping, [
            ...services,
          ]),
          context.config.sidecars.mapping,
        );
        return graph.phases.map((phase) => phase.services);
      },
    },
    execution: {
      async reconcileService(input) {
        const execution = await getPinnedExecution();
        const composeConfig = await captureResolvedCompose(context.scope.composePath, {
          profiles: context.scope.profiles,
          projectName: context.scope.project,
          envFile: context.envFile,
          cwd: context.projectDir,
          ...execution,
        });
        assertResolvedComposeAuthoritySnapshotable(composeConfig, input.service);
        if (
          composeConfig === undefined ||
          input.expectedResolvedComposeFingerprint === undefined ||
          resolvedServiceConfigFingerprint(composeConfig) !==
            input.expectedResolvedComposeFingerprint
        ) {
          throw new Error("Resolved Compose authority changed before reconciliation");
        }
        return executeTarget(
          {
            ...input,
            projectDirectory: context.projectDir,
            resolvedComposeJson: JSON.stringify(composeConfig),
          },
          {
            cwd: context.projectDir,
            ...execution,
          },
        );
      },
      async verifyReadiness(service) {
        const execution = await getPinnedExecution();
        const containers = await getRunningServiceContainerMap(context.scope.composePath, {
          projectName: context.scope.project,
          profiles: context.scope.profiles,
          envFile: context.envFile,
          cwd: context.projectDir,
          ...execution,
        });
        const containerName = containers?.get(service);
        if (containerName === undefined) return false;
        const identity = await inspectContainerIdentity(containerName, {
          cwd: context.projectDir,
          ...execution,
        });
        const verification = await verifyServiceReadiness({
          composePath: context.scope.composePath,
          projectName: context.scope.project,
          targetService: service,
          expectedImageId: identity.localImageId,
          projectDir: context.projectDir,
          profiles: context.scope.profiles,
          envFile: context.envFile,
          ...execution,
          poll: context.healthPoll,
        });
        return verification.ready;
      },
    },
    lock: { acquire: acquireLifecycleLock },
    policy: allowAllReconcilePolicy,
    signal,
    clock: { now: Date.now },
  };
}

const defaultDependencies: ReconcileActionDependencies = {
  loadConfig,
  applyCliOverrides,
  resolveServices: resolveServicesWithInteractive,
  getComposeServices,
  resolveComposeEnvironmentFilePath,
  resolveComposeProjectIdentity,
  captureSnapshot: captureProductionSnapshot,
  createCoordinatorDependencies: createProductionCoordinatorDependencies,
  buildReconcilePlan,
  runReconcile,
  confirm,
  formatOutput,
};

function installSignalTracker(): { tracker: ReconcileSignalTracker; dispose(): void } {
  let interruption: "SIGINT" | "SIGTERM" | undefined;
  const onSigint = () => {
    interruption = "SIGINT";
  };
  const onSigterm = () => {
    interruption = "SIGTERM";
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return {
    tracker: { getInterruption: () => interruption },
    dispose() {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    },
  };
}

function actionableServices(result: ReconcileResult): ReconcileServiceResult[] {
  return result.services.filter((service) =>
    ["create", "start", "recreate"].includes(service.action.kind),
  );
}

function declinedResult(reviewed: ReconcileResult): ReconcileResult {
  const services = reviewed.services.map((service): ReconcileServiceResult => {
    if (!["create", "start", "recreate"].includes(service.action.kind)) return service;
    return { ...service, outcome: "cancelled_before_action" };
  });
  return {
    ...reviewed,
    status: "cancelled",
    services,
    summary: summarizeReconcileServices(services),
    success: false,
    exitCode: 2,
  };
}

function serviceRows(result: ReconcileResult, showUnchanged: boolean) {
  return result.services
    .filter((service) => showUnchanged || service.comparison !== "in_sync")
    .map((service) => ({
      service: service.service,
      comparison: service.comparison,
      action: service.action.kind,
      categories: service.action.categories.join(","),
      eligibility: service.action.eligibility,
      outcome: service.outcome,
      drift: service.drift.hasDrift,
    }));
}

function displayText(result: ReconcileResult, showUnchanged: boolean): void {
  console.error("");
  console.error(`Reconciliation ${result.mode}: ${result.status}`);
  console.error(
    `Scope: ${result.summary.selected} service(s); ${result.summary.actionable} actionable; ` +
      `${result.summary.inSync} in sync`,
  );
  for (const service of result.services) {
    if (!showUnchanged && service.comparison === "in_sync") continue;
    const categories = service.action.categories.join(", ") || "none";
    const reasons = service.action.reasons.map((reason) => reason.code).join(", ") || "none";
    console.error(
      `  ${service.service}: ${service.comparison} -> ${service.action.kind} ` +
        `[${categories}] (${reasons}); ${service.outcome}`,
    );
  }
  if (result.mode === "report" || result.dryRun) {
    console.error("No changes were made.");
    console.error("Run with --auto-apply to apply the declared Compose state.");
  }
}

async function emitResult(
  result: ReconcileResult,
  options: Pick<NormalizedReconcileOptions, "format" | "showUnchanged" | "verbose">,
  dependencies: ReconcileActionDependencies,
): Promise<void> {
  const showUnchanged = options.showUnchanged || options.verbose;
  if (options.format === "text") {
    displayText(result, showUnchanged);
  } else if (options.format === "json" || options.format === "yaml") {
    await dependencies.formatOutput(options.format, result);
  } else {
    await dependencies.formatOutput(options.format, serviceRows(result, showUnchanged));
  }
  process.exitCode = result.exitCode;
}

/** Execute a report or explicitly authorized same-process reconciliation. */
export async function executeReconcile(
  rawOptions: RawReconcileOptions,
  globalOptions: ReconcileGlobalOptions,
  dependencies: ReconcileActionDependencies = defaultDependencies,
): Promise<void> {
  const options = normalizeOptions(rawOptions, globalOptions);
  logDebug(`Reconcile mode: ${options.autoApply ? "auto-apply" : "report"}`);

  const config = await dependencies.loadConfig();
  if (options.profile !== undefined && !isValidProfile(options.profile, config)) {
    throw new InvalidArgumentError(
      "--profile",
      options.profile,
      "Unknown profile",
      config.profiles.validProfiles,
    );
  }
  const finalConfig = dependencies.applyCliOverrides(config, {
    composePath: options.composePath,
    envFile: options.envFile,
    profile: options.profile,
    noSidecars: options.noSidecars,
  });
  if (options.group !== undefined && finalConfig.groups[options.group]?.length === 0) {
    throw new InvalidArgumentError(
      "--group",
      options.group,
      "Explicit selection resolved to no services",
    );
  }
  const envTool = getEnvToolExecConfig(globalOptions, finalConfig);
  let envFile: string;
  try {
    envFile = await dependencies.resolveComposeEnvironmentFilePath(finalConfig.envFile);
  } catch (error) {
    throw new InvalidArgumentError(
      "--env-file",
      finalConfig.envFile,
      error instanceof Error ? error.message : "Environment file could not be resolved safely",
    );
  }
  let project: ComposeProjectIdentity;
  try {
    project = await dependencies.resolveComposeProjectIdentity(finalConfig.composePath, {
      envFile,
      envTool,
    });
  } catch (error) {
    throw new InvalidArgumentError(
      "--compose",
      finalConfig.composePath,
      error instanceof Error ? error.message : "Compose path could not be resolved safely",
    );
  }

  const resolved = await dependencies.resolveServices(
    {
      ...(options.service === undefined ? {} : { service: options.service }),
      ...(options.services === undefined ? {} : { services: options.services }),
      ...(options.group === undefined ? {} : { group: options.group }),
      ...(options.tag === undefined ? {} : { tag: options.tag }),
      noSidecars: options.noSidecars,
      sidecars: options.noSidecars ? false : undefined,
      // Reconciliation selection is always deterministic and non-interactive.
      yes: true,
    },
    finalConfig,
    project.composePath,
    project.projectDir,
    { envTool },
  );
  if (resolved === null) return;

  // Selector site 4. Open-coding this predicate is what lets a zero-match --tag fall
  // through to the `[]` "whole project" sentinel and reconcile the entire fleet.
  if (hasExplicitSelector(options) && resolved.services.length === 0) {
    const blame = selectorBlame(options, "");
    throw new InvalidArgumentError(
      blame.argument,
      blame.value,
      "Explicit selection resolved to no services",
    );
  }

  const profiles = uniqueSorted(
    options.profile === undefined ? resolved.profiles : [options.profile],
  );
  const selected =
    resolved.services.length === 0
      ? await dependencies.getComposeServices(project.composePath, {
          profiles,
          projectName: project.projectName,
          envFile,
          envTool,
        })
      : resolved.services;
  const services = uniqueSorted(selected);
  if (services.length === 0) {
    throw new InvalidArgumentError(
      "--service",
      "",
      "No Compose services were available for reconciliation",
    );
  }
  try {
    assertReconcileScopeServices(services);
  } catch (error) {
    const blame = selectorBlame(options, "all");
    throw new InvalidArgumentError(
      blame.argument,
      blame.value,
      error instanceof Error ? error.message : "Reconciliation scope is too large",
    );
  }

  const context: ReconcileRuntimeContext = {
    mode: options.autoApply ? "auto-apply" : "report",
    dryRun: options.dryRun,
    scope: {
      composePath: project.composePath,
      project: project.projectName,
      profiles,
      services,
    },
    projectDir: project.projectDir,
    envFile,
    envTool,
    config: finalConfig,
    healthPoll: {
      timeoutSeconds: options.healthTimeout ?? finalConfig.healthCheck.timeout,
      intervalSeconds: finalConfig.healthCheck.interval,
      retries: finalConfig.healthCheck.retries,
    },
  };
  const snapshot = await dependencies.captureSnapshot(context);
  const reviewed = dependencies.buildReconcilePlan(snapshot);
  const actionable = actionableServices(reviewed);

  if (
    options.autoApply &&
    !options.dryRun &&
    actionable.length > 0 &&
    isMachineFormat(options.format) &&
    !options.yes
  ) {
    throw new InvalidArgumentError(
      "--yes",
      "false",
      "Machine-format mutation requires explicit --auto-apply --yes",
    );
  }

  if (!options.autoApply || options.dryRun || actionable.length === 0) {
    const result = await dependencies.runReconcile(snapshot);
    await emitResult(result, options, dependencies);
    return;
  }

  if (options.format === "text") {
    displayText(reviewed, options.showUnchanged || options.verbose);
  }
  if (!options.yes) {
    const targets = actionable.map((service) => service.service).join(", ");
    const approved = await dependencies.confirm(
      `Apply ${actionable.length} reconciliation action(s) to ${targets}? ` +
        "Compose state is authoritative and containers may restart.",
    );
    if (!approved) {
      await emitResult(declinedResult(reviewed), options, dependencies);
      return;
    }
  }

  const signals = installSignalTracker();
  try {
    const coordinator = dependencies.createCoordinatorDependencies(context, signals.tracker);
    const result = await dependencies.runReconcile(
      snapshot,
      { projectDir: project.projectDir },
      coordinator,
    );
    await emitResult(result, options, dependencies);
  } finally {
    signals.dispose();
  }
}
