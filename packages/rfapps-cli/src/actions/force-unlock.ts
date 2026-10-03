import {
  confirm,
  isMachineFormat,
  logInfo,
  logSuccess,
  logWarn,
  type OutputFormat,
} from "@rfmedia/common";

import { InvalidArgumentError } from "../lib/errors.js";
import { formatOutput } from "../lib/formatters/index.js";
import {
  forceUnlockStateLock,
  inspectStateLock,
  type StateLockInspection,
} from "../lib/state-lock.js";

export interface ForceUnlockGlobalOptions {
  readonly dryRun?: boolean;
  readonly yes?: boolean;
  readonly json?: boolean;
  readonly output?: OutputFormat;
}

export interface ForceUnlockResult {
  readonly operation: "force-unlock";
  readonly path: string;
  readonly previousStatus: StateLockInspection["status"];
  readonly dryRun: boolean;
  readonly unlocked: boolean;
  readonly cancelled: boolean;
}

export interface ForceUnlockDependencies {
  inspect(): Promise<StateLockInspection>;
  forceUnlock(inspection: StateLockInspection): Promise<boolean>;
  confirm(message: string): Promise<boolean>;
  output(format: OutputFormat, result: ForceUnlockResult): Promise<void>;
}

const defaultDependencies: ForceUnlockDependencies = {
  inspect: () => inspectStateLock(),
  forceUnlock: forceUnlockStateLock,
  confirm,
  output: formatOutput,
};

function outputFormat(options: ForceUnlockGlobalOptions): OutputFormat {
  if (options.output !== undefined) {
    return options.output;
  }
  return options.json === true ? "json" : "text";
}

async function emitResult(
  result: ForceUnlockResult,
  format: OutputFormat,
  dependencies: ForceUnlockDependencies,
): Promise<void> {
  if (format !== "text") {
    await dependencies.output(format, result);
  }
}

export async function executeForceUnlock(
  options: ForceUnlockGlobalOptions,
  dependencies: ForceUnlockDependencies = defaultDependencies,
): Promise<ForceUnlockResult> {
  const format = outputFormat(options);
  const inspection = await dependencies.inspect();

  if (inspection.status === "missing") {
    const result: ForceUnlockResult = {
      operation: "force-unlock",
      path: inspection.path,
      previousStatus: inspection.status,
      dryRun: options.dryRun === true,
      unlocked: false,
      cancelled: false,
    };
    logInfo(`No state lock found at ${inspection.path}`);
    await emitResult(result, format, dependencies);
    return result;
  }

  if (options.dryRun === true) {
    const result: ForceUnlockResult = {
      operation: "force-unlock",
      path: inspection.path,
      previousStatus: inspection.status,
      dryRun: true,
      unlocked: false,
      cancelled: false,
    };
    logInfo(`Dry run: state lock at ${inspection.path} would be removed`);
    await emitResult(result, format, dependencies);
    return result;
  }

  if (inspection.status === "invalid") {
    logWarn(
      `DANGER: ${inspection.reason} at ${inspection.path}. ` +
        "Force-unlock can permit overlapping mutations.",
    );
  } else {
    logWarn(
      `DANGER: state lock is ${inspection.status} for ${inspection.metadata.operation} ` +
        `by ${inspection.metadata.who} since ${inspection.metadata.when}. ` +
        "Force-unlock can permit overlapping mutations.",
    );
  }

  if (isMachineFormat(format) && options.yes !== true) {
    throw new InvalidArgumentError(
      "--yes",
      "false",
      "Machine-format force-unlock requires explicit --yes",
      ["--yes"],
    );
  }

  if (options.yes !== true) {
    const confirmed = await dependencies.confirm(
      `Force-unlock ${inspection.path}? Verify no rfapps mutation is still active.`,
    );
    if (!confirmed) {
      const result: ForceUnlockResult = {
        operation: "force-unlock",
        path: inspection.path,
        previousStatus: inspection.status,
        dryRun: false,
        unlocked: false,
        cancelled: true,
      };
      logInfo("Cancelled");
      await emitResult(result, format, dependencies);
      return result;
    }
  }

  const unlocked = await dependencies.forceUnlock(inspection);
  const result: ForceUnlockResult = {
    operation: "force-unlock",
    path: inspection.path,
    previousStatus: inspection.status,
    dryRun: false,
    unlocked,
    cancelled: false,
  };
  logSuccess(unlocked ? `Removed state lock at ${inspection.path}` : "No state lock was removed");
  await emitResult(result, format, dependencies);
  return result;
}
