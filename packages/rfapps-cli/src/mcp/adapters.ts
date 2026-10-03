import { normalizeMcpError } from "@rfmedia/common";

import { executeApply } from "../actions/apply.js";
import { executeDelete } from "../actions/delete.js";
import { executeDriftDetect, executeDriftImport, executeDriftShow } from "../actions/drift.js";
import { executeReconcile } from "../actions/reconcile.js";
import { executeDeploy } from "../actions/deploy.js";
import { executeHealth } from "../actions/health.js";
import { executeHistory } from "../actions/history.js";
import { executePlan } from "../actions/plan.js";
import { executePrune } from "../actions/prune.js";
import { executePull } from "../actions/pull.js";
import { executeRebuild } from "../actions/rebuild.js";
import { executeRollback } from "../actions/rollback.js";
import { executeStatus } from "../actions/status.js";
import { executeStop } from "../actions/stop.js";
import { withFormatOutputCapture } from "../lib/formatters/index.js";

import type {
  ApplyResult,
  DeleteResult,
  DeployResult,
  DriftResult,
  HealthCommandResult,
  HistoryResult,
  PullResult,
  ReconcileResult,
  RebuildResult,
  RollbackResult,
  StatusResult,
  StopResult,
  PruneResult,
  DeploymentPlan,
  ServiceDrift,
} from "../types/index.js";
import type {
  ApplyToolArgs,
  DeleteToolArgs,
  DeployToolArgs,
  DriftDetectToolArgs,
  DriftImportToolArgs,
  DriftShowToolArgs,
  HealthToolArgs,
  HistoryToolArgs,
  McpExecutionArgs,
  PlanToolArgs,
  PruneToolArgs,
  PullToolArgs,
  RebuildToolArgs,
  RollbackToolArgs,
  ReconcileToolArgs,
  StatusToolArgs,
} from "./schema.js";

interface ActionGlobalOptions {
  dryRun?: boolean;
  debug?: boolean;
  json?: boolean;
  output?: "json";
  verbose?: boolean;
  yes?: boolean;
  useDotenvx?: string;
  useOp?: string;
}

interface AdapterDryRunResult {
  dryRun: boolean;
}

interface DriftMutationResult {
  success: boolean;
  operation: string;
  services?: string[];
}

export class RfappsMcpAdapterError extends Error {
  readonly envelope: ReturnType<typeof normalizeMcpError>;

  constructor(error: unknown) {
    const envelope = normalizeMcpError(error);
    super(envelope.message);
    this.name = "RfappsMcpAdapterError";
    this.envelope = envelope;
  }
}

function buildGlobalOptions(args: McpExecutionArgs): ActionGlobalOptions {
  const options: ActionGlobalOptions = {
    dryRun: args.dryRun,
    debug: args.debug,
    json: true,
    output: "json",
    verbose: args.verbose,
    useDotenvx: args.useDotenvx,
    useOp: args.useOp,
  };

  if (args.yes !== undefined) {
    options.yes = args.yes;
  }

  return options;
}

function toServicesOption(services: string[] | undefined): string | undefined {
  if (services === undefined || services.length === 0) {
    return undefined;
  }
  return services.join(",");
}

function toSidecarsOption(noSidecars: boolean | undefined): boolean | undefined {
  if (noSidecars === undefined) {
    return undefined;
  }
  return !noSidecars;
}

function parseCapturedOutput(captured: unknown[]): unknown | undefined {
  if (captured.length === 0) {
    return undefined;
  }

  for (let index = captured.length - 1; index >= 0; index -= 1) {
    const entry = captured[index];
    if (entry !== undefined) {
      return entry;
    }
  }
  return undefined;
}

let actionCaptureLock: Promise<void> = Promise.resolve();

async function withActionCaptureLock<TResult>(execute: () => Promise<TResult>): Promise<TResult> {
  const previous = actionCaptureLock;
  let release: (() => void) | undefined;
  actionCaptureLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;

  try {
    return await execute();
  } finally {
    release?.();
  }
}

async function runActionWithJsonCapture<TResult>(
  execute: () => Promise<void>,
  options?: {
    fallback?: TResult;
    failureMessage?: string;
    dryRun?: boolean;
    preserveStructuredFailure?: boolean;
  },
): Promise<TResult> {
  return withActionCaptureLock(async () => {
    const captured: unknown[] = [];
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await withFormatOutputCapture((_, payload) => {
        captured.push(payload);
      }, execute);

      const parsed = parseCapturedOutput(captured);

      if (
        process.exitCode !== undefined &&
        process.exitCode !== 0 &&
        !(options?.preserveStructuredFailure === true && parsed !== undefined)
      ) {
        const message = options?.failureMessage ?? "rfapps action execution failed";
        const resultMessage =
          parsed !== undefined && typeof parsed === "object" && parsed !== null && "error" in parsed
            ? String((parsed as { error: unknown }).error)
            : message;
        throw new Error(resultMessage);
      }

      if (parsed !== undefined) {
        return parsed as TResult;
      }

      if (options?.fallback !== undefined) {
        return options.fallback;
      }

      if (options?.dryRun === true) {
        return { dryRun: true } as TResult;
      }

      throw new Error("rfapps action produced no JSON output");
    } catch (error) {
      throw new RfappsMcpAdapterError(error);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
}

export async function invokeStatus(
  args: StatusToolArgs,
): Promise<StatusResult | AdapterDryRunResult> {
  return runActionWithJsonCapture<StatusResult | AdapterDryRunResult>(
    () =>
      executeStatus(
        {
          service: args.service,
          services: toServicesOption(args.services),
          all: args.all,
          health: args.health,
          stats: args.stats,
          logs: args.logs,
          compose: args.compose,
          envFile: args.envFile,
        },
        buildGlobalOptions(args),
      ),
    {
      dryRun: args.dryRun,
    },
  );
}

export async function invokePull(args: PullToolArgs): Promise<PullResult | AdapterDryRunResult> {
  return runActionWithJsonCapture<PullResult | AdapterDryRunResult>(
    () =>
      executePull(
        {
          service: args.service,
          services: toServicesOption(args.services),
          group: args.group,
          sidecars: toSidecarsOption(args.noSidecars),
          compose: args.compose,
          envFile: args.envFile,
          profile: args.profile,
        },
        buildGlobalOptions(args),
      ),
    {
      dryRun: args.dryRun,
    },
  );
}

export async function invokeHealth(
  args: HealthToolArgs,
): Promise<HealthCommandResult | AdapterDryRunResult> {
  return runActionWithJsonCapture<HealthCommandResult | AdapterDryRunResult>(
    () =>
      executeHealth(
        {
          service: args.service,
          services: toServicesOption(args.services),
          group: args.group,
          sidecars: toSidecarsOption(args.noSidecars),
          waitForReady: args.waitForReady,
          healthTimeout: args.healthTimeout,
          compose: args.compose,
          envFile: args.envFile,
          profile: args.profile,
        },
        buildGlobalOptions(args),
      ),
    {
      dryRun: args.dryRun,
    },
  );
}

export async function invokeDeploy(
  args: DeployToolArgs,
): Promise<DeployResult | AdapterDryRunResult> {
  return runActionWithJsonCapture<DeployResult | AdapterDryRunResult>(
    () =>
      executeDeploy(
        {
          service: args.service,
          services: toServicesOption(args.services),
          group: args.group,
          sidecars: toSidecarsOption(args.noSidecars),
          skipPull: args.skipPull,
          forceRecreate: args.forceRecreate,
          parallel: args.parallel,
          workers: args.workers,
          waitForReady: args.waitForReady,
          healthTimeout: args.healthTimeout,
          compose: args.compose,
          envFile: args.envFile,
          profile: args.profile,
        },
        buildGlobalOptions(args),
      ),
    {
      dryRun: args.dryRun,
    },
  );
}

export async function invokeRebuild(
  args: RebuildToolArgs,
): Promise<RebuildResult | AdapterDryRunResult> {
  return runActionWithJsonCapture<RebuildResult | AdapterDryRunResult>(
    () =>
      executeRebuild(
        {
          service: args.service,
          services: toServicesOption(args.services),
          group: args.group,
          sidecars: toSidecarsOption(args.noSidecars),
          skipPull: args.skipPull,
          parallel: args.parallel,
          workers: args.workers,
          waitForReady: args.waitForReady,
          healthTimeout: args.healthTimeout,
          compose: args.compose,
          envFile: args.envFile,
          profile: args.profile,
        },
        buildGlobalOptions(args),
      ),
    {
      dryRun: args.dryRun,
    },
  );
}

export async function invokeStop(args: PullToolArgs): Promise<StopResult | AdapterDryRunResult> {
  return runActionWithJsonCapture<StopResult | AdapterDryRunResult>(
    () =>
      executeStop(
        {
          service: args.service,
          services: toServicesOption(args.services),
          group: args.group,
          sidecars: toSidecarsOption(args.noSidecars),
          compose: args.compose,
          envFile: args.envFile,
          profile: args.profile,
        },
        buildGlobalOptions(args),
      ),
    {
      dryRun: args.dryRun,
    },
  );
}

export async function invokeDelete(
  args: DeleteToolArgs,
): Promise<DeleteResult | AdapterDryRunResult> {
  return runActionWithJsonCapture<DeleteResult | AdapterDryRunResult>(
    () =>
      executeDelete(
        {
          service: args.service,
          services: toServicesOption(args.services),
          group: args.group,
          sidecars: toSidecarsOption(args.noSidecars),
          compose: args.compose,
          envFile: args.envFile,
          profile: args.profile,
          volumes: args.volumes,
          images: args.images,
        },
        buildGlobalOptions(args),
      ),
    {
      dryRun: args.dryRun,
    },
  );
}

export async function invokePrune(args: PruneToolArgs): Promise<PruneResult | AdapterDryRunResult> {
  return runActionWithJsonCapture<PruneResult | AdapterDryRunResult>(
    () =>
      executePrune(
        {
          service: args.service,
          services: toServicesOption(args.services),
          group: args.group,
          sidecars: toSidecarsOption(args.noSidecars),
          compose: args.compose,
          envFile: args.envFile,
          profile: args.profile,
          volumes: args.volumes,
          images: args.images,
        },
        buildGlobalOptions(args),
      ),
    {
      dryRun: args.dryRun,
    },
  );
}

export async function invokePlan(
  args: PlanToolArgs,
): Promise<{ planPath: string; plan: DeploymentPlan } | AdapterDryRunResult> {
  return runActionWithJsonCapture<{ planPath: string; plan: DeploymentPlan } | AdapterDryRunResult>(
    () =>
      executePlan(
        {
          service: args.service,
          services: toServicesOption(args.services),
          group: args.group,
          sidecars: toSidecarsOption(args.noSidecars),
          apply: args.apply,
          out: args.out,
          showUnchanged: args.showUnchanged,
          checkUpdates: args.checkUpdates,
          explain: args.explain,
          compose: args.compose,
          envFile: args.envFile,
          profile: args.profile,
        },
        buildGlobalOptions(args),
      ),
    {
      dryRun: args.dryRun,
    },
  );
}

export async function invokeApply(args: ApplyToolArgs): Promise<ApplyResult | AdapterDryRunResult> {
  return runActionWithJsonCapture<ApplyResult | AdapterDryRunResult>(
    () =>
      executeApply(
        {
          planFile: args.planFile,
          force: args.force,
        },
        buildGlobalOptions(args),
      ),
    {
      dryRun: args.dryRun,
    },
  );
}

export async function invokeHistory(args: HistoryToolArgs): Promise<HistoryResult> {
  return runActionWithJsonCapture<HistoryResult>(() =>
    executeHistory(
      {
        service: args.service,
        limit: args.limit?.toString(),
        since: args.since,
        action: args.action,
      },
      buildGlobalOptions(args),
    ),
  );
}

export async function invokeRollback(
  args: RollbackToolArgs,
): Promise<RollbackResult | AdapterDryRunResult> {
  return runActionWithJsonCapture<RollbackResult | AdapterDryRunResult>(
    () =>
      executeRollback(
        {
          service: args.service,
          steps: args.steps?.toString(),
          toDeployment: args.toDeployment?.toString(),
          toGeneration: args.toGeneration?.toString(),
          toTime: args.toTime,
          force: args.force,
        },
        buildGlobalOptions(args),
      ),
    {
      dryRun: args.dryRun,
    },
  );
}

export async function invokeDriftDetect(
  args: DriftDetectToolArgs,
): Promise<DriftResult | AdapterDryRunResult> {
  return runActionWithJsonCapture<DriftResult | AdapterDryRunResult>(
    () =>
      executeDriftDetect(
        {
          service: args.service,
          services: toServicesOption(args.services),
          group: args.group,
          sidecars: toSidecarsOption(args.noSidecars),
          showUnchanged: args.showUnchanged,
          reportOnly: args.reportOnly,
          compose: args.compose,
          envFile: args.envFile,
          profile: args.profile,
        },
        buildGlobalOptions(args),
      ),
    {
      dryRun: args.dryRun,
    },
  );
}

export async function invokeDriftShow(
  args: DriftShowToolArgs,
): Promise<{ service: string; drift: ServiceDrift } | AdapterDryRunResult> {
  return runActionWithJsonCapture<{ service: string; drift: ServiceDrift } | AdapterDryRunResult>(
    () =>
      executeDriftShow(
        {
          service: args.service,
          reportOnly: args.reportOnly,
          compose: args.compose,
          envFile: args.envFile,
          profile: args.profile,
        },
        buildGlobalOptions(args),
      ),
    {
      dryRun: args.dryRun,
    },
  );
}

export async function invokeDriftReconcile(args: ReconcileToolArgs): Promise<ReconcileResult> {
  if (args.autoApply === true && args.yes !== true) {
    throw new RfappsMcpAdapterError(
      new Error("MCP reconciliation auto-apply requires explicit autoApply: true and yes: true"),
    );
  }

  return runActionWithJsonCapture<ReconcileResult>(
    () =>
      executeReconcile(
        {
          service: args.service,
          services: toServicesOption(args.services),
          group: args.group,
          sidecars: toSidecarsOption(args.noSidecars),
          autoApply: args.autoApply,
          showUnchanged: args.showUnchanged,
          healthTimeout: args.healthTimeout,
          compose: args.compose,
          envFile: args.envFile,
          profile: args.profile,
        },
        buildGlobalOptions(args),
      ),
    {
      failureMessage: "Drift reconciliation failed",
      preserveStructuredFailure: true,
    },
  );
}

export async function invokeDriftImport(
  args: DriftImportToolArgs,
): Promise<DriftMutationResult | AdapterDryRunResult> {
  return runActionWithJsonCapture<DriftMutationResult | AdapterDryRunResult>(
    () =>
      executeDriftImport(
        {
          service: args.service,
          services: toServicesOption(args.services),
          group: args.group,
          sidecars: toSidecarsOption(args.noSidecars),
          backup: args.backup,
          compose: args.compose,
          envFile: args.envFile,
          profile: args.profile,
        },
        buildGlobalOptions(args),
      ),
    {
      fallback: {
        success: true,
        operation: "drift.import",
        services: args.services,
      },
      failureMessage: "Drift import failed",
      dryRun: args.dryRun,
    },
  );
}

export const rfappsActionAdapters = {
  status: invokeStatus,
  health: invokeHealth,
  pull: invokePull,
  deploy: invokeDeploy,
  rebuild: invokeRebuild,
  stop: invokeStop,
  delete: invokeDelete,
  prune: invokePrune,
  plan: invokePlan,
  apply: invokeApply,
  history: invokeHistory,
  rollback: invokeRollback,
  driftDetect: invokeDriftDetect,
  driftShow: invokeDriftShow,
  driftReconcile: invokeDriftReconcile,
  driftImport: invokeDriftImport,
} as const;
