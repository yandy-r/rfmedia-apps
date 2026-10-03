import {
  type ReconciliationEnginePlan,
  type ReconciliationEngineRecord,
} from "../../lib/reconciliation.js";
import { validateReconciliationServerTrack } from "../../lib/reconciliation-limits.js";
import { projectRatingWrite } from "../../lib/tag-writer.js";
import type {
  DbConnection,
  ReconciliationDatabaseAuthorityLease,
  ReconciliationDatabaseGeneration,
  ReconciliationInventoryUpdate,
} from "../../types/db.js";
import type {
  MediaLibraryContentVersion,
  MediaServerAdapter,
  MediaTrack,
} from "../../types/media-server.js";
import type {
  DatabaseStatOutcome,
  RatingTargetOutcome,
  ReconciliationFailureCode,
  ReconciliationTargetOutcome,
} from "../../types/reconciliation.js";
import {
  acquireServerSnapshot,
  checkedRegularFile,
  fingerprint,
  sameFingerprint,
  sameServerContentVersion,
  throwIfCancelled,
  type FileFingerprint,
  type ReconciliationAcquisition,
} from "./acquisition.js";
import type {
  ReconciliationActionDependencies,
  ReconciliationApplyActionOptions,
} from "./contracts.js";
import {
  addOutcome,
  compareOutcomeOrder,
  databaseRowsMatch,
  failFirstPlannedOutcome,
  getDatabaseStatOutcome,
  getRatingOutcome,
  indexOutcomes,
  markLaterPathOutcomesSkipped,
  markRemainingCancelled,
  replaceOutcome,
  serverTrackIdentitiesMatch,
  serverTracksMatch,
  type OutcomeIndexes,
} from "./outcomes.js";

interface FreshPlanExecutionState {
  readonly outcomes: ReconciliationTargetOutcome[];
  readonly outcomeIndexes: OutcomeIndexes;
  readonly touchedPaths: Set<string>;
  readonly failureCodes: ReconciliationFailureCode[];
}

type ExecutionStep = "continue" | "skip-path" | "cancelled";

interface RecordGuard {
  readonly serverContentVersion: MediaLibraryContentVersion;
  readonly databaseGeneration: ReconciliationDatabaseGeneration;
  readonly authorityLease?: ReconciliationDatabaseAuthorityLease;
}

interface DatabaseExecution {
  readonly step: ExecutionStep;
  readonly databaseGeneration: ReconciliationDatabaseGeneration;
  readonly pendingAuthorityOutcomes: readonly (RatingTargetOutcome | DatabaseStatOutcome)[];
}

export interface ReconciliationPlanExecution {
  readonly outcomes: readonly ReconciliationTargetOutcome[];
  readonly failureCodes: readonly ReconciliationFailureCode[];
  readonly touchedPaths: ReadonlySet<string>;
}

function acquireFreshDatabaseRows(
  database: DbConnection,
  path: string,
  operationId: number | undefined,
  dependencies: ReconciliationActionDependencies,
) {
  return dependencies.getReconciliationInventoryCandidatesAtPath(database, path, operationId);
}

async function acquireFreshServerTracks(
  expected: readonly MediaTrack[],
  adapter: MediaServerAdapter,
  signal?: AbortSignal,
): Promise<readonly MediaTrack[]> {
  const tracks = await Promise.all(
    expected.map((track) => adapter.query.trackById(track.id, { signal })),
  );
  if (tracks.some((track) => !validateReconciliationServerTrack(track).ok)) {
    throw new Error("stale-evidence");
  }
  return tracks;
}

async function revalidateFile(
  path: string,
  expected: FileFingerprint,
  dependencies: ReconciliationActionDependencies,
) {
  const before = await dependencies.lstat(path);
  if (!checkedRegularFile(before) || !sameFingerprint(expected, fingerprint(before))) {
    throw new Error("stale-evidence");
  }
  const metadata = await dependencies.readReconciliationMetadata(path);
  const after = await dependencies.lstat(path);
  const afterFingerprint = fingerprint(after);
  if (!checkedRegularFile(after) || !sameFingerprint(expected, afterFingerprint)) {
    throw new Error("stale-evidence");
  }
  return { fingerprint: afterFingerprint, metadata };
}

function sameDatabaseGeneration(
  left: ReconciliationDatabaseGeneration,
  right: ReconciliationDatabaseGeneration,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function hasPlannedDatabaseOutcome(state: FreshPlanExecutionState, path: string): boolean {
  return (
    getRatingOutcome(state.outcomes, state.outcomeIndexes, path, "database")?.status ===
      "planned" ||
    getDatabaseStatOutcome(state.outcomes, state.outcomeIndexes, path)?.status === "planned"
  );
}

function hasPlannedExternalOutcome(state: FreshPlanExecutionState, path: string): boolean {
  return (
    getRatingOutcome(state.outcomes, state.outcomeIndexes, path, "file")?.status === "planned" ||
    getRatingOutcome(state.outcomes, state.outcomeIndexes, path, "server")?.status === "planned"
  );
}

function guardDatabaseRowsReadOnly(
  options: ReconciliationApplyActionOptions,
  acquisition: ReconciliationAcquisition,
  record: ReconciliationEngineRecord,
  trustedGeneration: ReconciliationDatabaseGeneration,
  dependencies: ReconciliationActionDependencies,
): void {
  const snapshot = dependencies.openReconciliationDatabaseReadOnly(acquisition.databasePath);
  try {
    if (!sameDatabaseGeneration(trustedGeneration, snapshot.generation)) {
      throw new Error("stale-evidence");
    }
    const currentRows = acquireFreshDatabaseRows(
      snapshot.database,
      record.path,
      options.operationId,
      dependencies,
    );
    if (!databaseRowsMatch(record.databaseRows, currentRows)) {
      throw new Error("stale-evidence");
    }
  } finally {
    dependencies.closeDatabase(snapshot.database);
  }
}

async function guardFreshPlanRecord(
  options: ReconciliationApplyActionOptions,
  acquisition: ReconciliationAcquisition,
  plan: ReconciliationEnginePlan,
  record: ReconciliationEngineRecord,
  state: FreshPlanExecutionState,
  executionAdapter: MediaServerAdapter,
  trustedServerContentVersion: MediaLibraryContentVersion,
  trustedDatabaseGeneration: ReconciliationDatabaseGeneration,
  dependencies: ReconciliationActionDependencies,
): Promise<RecordGuard> {
  const expectedFingerprint = acquisition.fingerprints.get(record.path);
  let checkedMetadata:
    | Awaited<ReturnType<ReconciliationActionDependencies["readReconciliationMetadata"]>>
    | undefined;
  if (expectedFingerprint !== undefined) {
    checkedMetadata = (await revalidateFile(record.path, expectedFingerprint, dependencies))
      .metadata;
    if (!checkedMetadata.ok) throw new Error("stale-evidence");
  }

  const currentServerTracks = await acquireFreshServerTracks(
    record.serverTracks,
    executionAdapter,
    options.signal,
  );
  if (
    !serverTracksMatch(
      acquisition.report.sourceRoot,
      record.path,
      record.serverTracks,
      currentServerTracks,
    )
  ) {
    throw new Error("stale-evidence");
  }
  if (plan.strategy === "file-wins") {
    const authority = record.evidence.rating.find((value) => value.plane === "file");
    if (
      authority?.state !== "present" ||
      typeof authority.value !== "number" ||
      checkedMetadata?.ok !== true ||
      checkedMetadata.metadata.rating !== authority.value
    ) {
      throw new Error("stale-evidence");
    }
  }

  let serverContentVersion = trustedServerContentVersion;
  const currentServerContentVersion = await executionAdapter.query.libraryContentVersion(
    acquisition.library,
    { signal: options.signal },
  );
  if (!sameServerContentVersion(serverContentVersion, currentServerContentVersion)) {
    const refreshAdapter = dependencies.createAdapter();
    const refreshedServer = await acquireServerSnapshot(
      refreshAdapter,
      acquisition.library,
      dependencies.advancePaginationOffset,
      options.signal,
    );
    if (!serverTrackIdentitiesMatch(acquisition.serverTracks, refreshedServer.tracks)) {
      throw new Error("stale-evidence");
    }
    const refreshedCurrentTracks = await acquireFreshServerTracks(
      record.serverTracks,
      refreshAdapter,
      options.signal,
    );
    if (
      !serverTracksMatch(
        acquisition.report.sourceRoot,
        record.path,
        record.serverTracks,
        refreshedCurrentTracks,
      )
    ) {
      throw new Error("stale-evidence");
    }
    serverContentVersion = refreshedServer.contentVersion;
  }

  const requiresAuthorityLease =
    plan.strategy === "db-wins" && hasPlannedExternalOutcome(state, record.path);
  if (requiresAuthorityLease) {
    let authorityLease: ReconciliationDatabaseAuthorityLease | undefined;
    try {
      authorityLease = dependencies.openReconciliationDatabaseAuthorityLease(
        acquisition.databasePath,
        trustedDatabaseGeneration,
      );
      const currentRows = acquireFreshDatabaseRows(
        authorityLease.connection,
        record.path,
        options.operationId,
        dependencies,
      );
      if (!databaseRowsMatch(record.databaseRows, currentRows)) {
        throw new Error("stale-evidence");
      }
      return {
        serverContentVersion,
        databaseGeneration: trustedDatabaseGeneration,
        authorityLease,
      };
    } catch (error) {
      authorityLease?.rollback();
      throw error;
    }
  }

  if (hasPlannedDatabaseOutcome(state, record.path)) {
    guardDatabaseRowsReadOnly(
      options,
      acquisition,
      record,
      trustedDatabaseGeneration,
      dependencies,
    );
  } else {
    dependencies.assertReconciliationDatabaseGenerationCurrent(
      acquisition.databasePath,
      trustedDatabaseGeneration,
    );
  }
  return { serverContentVersion, databaseGeneration: trustedDatabaseGeneration };
}

async function executeFileRatingOutcome(
  options: ReconciliationApplyActionOptions,
  record: ReconciliationEngineRecord,
  state: FreshPlanExecutionState,
  dependencies: ReconciliationActionDependencies,
): Promise<ExecutionStep> {
  const fileOutcome = getRatingOutcome(state.outcomes, state.outcomeIndexes, record.path, "file");
  if (fileOutcome?.status !== "planned") return "continue";

  const projected = projectRatingWrite(record.path, fileOutcome.intended);
  if (!projected.supported || projected.normalized === null) {
    replaceOutcome(state.outcomes, state.outcomeIndexes, fileOutcome, {
      ...fileOutcome,
      status: "unsupported",
      code: "unsupported-target",
    });
    markLaterPathOutcomesSkipped(state.outcomes, state.outcomeIndexes, record.path);
    return "skip-path";
  }

  try {
    throwIfCancelled(options.signal);
    const write = await dependencies.writeRating(record.path, fileOutcome.intended, {
      popmEmail: options.popmEmail,
      signal: options.signal,
    });
    if (!write.success) {
      replaceOutcome(state.outcomes, state.outcomeIndexes, fileOutcome, {
        ...fileOutcome,
        status: "failed",
        code: "write-failed",
      });
      markLaterPathOutcomesSkipped(state.outcomes, state.outcomeIndexes, record.path);
      state.failureCodes.push("write-failed");
      return "skip-path";
    }
    state.touchedPaths.add(record.path);

    const afterWrite = await dependencies.lstat(record.path);
    if (!checkedRegularFile(afterWrite)) throw new Error("verification-failed");
    const afterFingerprint = fingerprint(afterWrite);
    const verify = await dependencies.readReconciliationMetadata(record.path);
    const afterVerify = await dependencies.lstat(record.path);
    if (
      !verify.ok ||
      verify.metadata.rating !== projected.normalized ||
      !checkedRegularFile(afterVerify) ||
      !sameFingerprint(afterFingerprint, fingerprint(afterVerify))
    ) {
      throw new Error("verification-failed");
    }
    replaceOutcome(state.outcomes, state.outcomeIndexes, fileOutcome, {
      ...fileOutcome,
      status: "applied",
      code: "applied",
    });

    const row = record.databaseRows.length === 1 ? record.databaseRows[0]! : undefined;
    if (
      row !== undefined &&
      (row.mtime !== afterFingerprint.mtimeMs || row.size !== afterFingerprint.size)
    ) {
      const existingStat = getDatabaseStatOutcome(
        state.outcomes,
        state.outcomeIndexes,
        record.path,
      );
      const intended = {
        mtime: Math.trunc(afterFingerprint.mtimeMs),
        size: afterFingerprint.size,
      };
      if (existingStat === undefined) {
        addOutcome(state.outcomes, state.outcomeIndexes, {
          kind: "database-stat",
          path: record.path,
          target: "database",
          inventoryRowId: row.id,
          status: "planned",
          code: "planned",
          before: { mtime: row.mtime, size: row.size },
          intended,
        });
      } else {
        replaceOutcome(state.outcomes, state.outcomeIndexes, existingStat, {
          ...existingStat,
          intended,
        });
      }
    }
    return "continue";
  } catch {
    if (options.signal?.aborted) {
      replaceOutcome(state.outcomes, state.outcomeIndexes, fileOutcome, {
        ...fileOutcome,
        status: "skipped",
        code: "cancelled",
      });
      markRemainingCancelled(state.outcomes);
      state.failureCodes.push("cancelled");
      return "cancelled";
    }
    const current = getRatingOutcome(state.outcomes, state.outcomeIndexes, record.path, "file");
    if (current?.status === "planned") {
      replaceOutcome(state.outcomes, state.outcomeIndexes, current, {
        ...current,
        status: "failed",
        code: "verification-failed",
      });
    }
    markLaterPathOutcomesSkipped(state.outcomes, state.outcomeIndexes, record.path);
    state.failureCodes.push("verification-failed");
    return "skip-path";
  }
}

async function executeServerRatingOutcome(
  options: ReconciliationApplyActionOptions,
  record: ReconciliationEngineRecord,
  state: FreshPlanExecutionState,
  executionAdapter: MediaServerAdapter,
): Promise<ExecutionStep> {
  const serverOutcome = getRatingOutcome(
    state.outcomes,
    state.outcomeIndexes,
    record.path,
    "server",
  );
  if (serverOutcome?.status !== "planned") return "continue";

  try {
    throwIfCancelled(options.signal);
    const track = record.serverTracks.length === 1 ? record.serverTracks[0] : undefined;
    if (track === undefined) throw new Error("stale-evidence");
    const write = await executionAdapter.metadata.updateTrackRating(
      track.id,
      serverOutcome.intended,
    );
    if (!write.success) throw new Error("write-failed");
    state.touchedPaths.add(record.path);
    replaceOutcome(state.outcomes, state.outcomeIndexes, serverOutcome, {
      ...serverOutcome,
      status: "applied",
      code: "applied",
    });
    return "continue";
  } catch (error: unknown) {
    if (options.signal?.aborted) {
      replaceOutcome(state.outcomes, state.outcomeIndexes, serverOutcome, {
        ...serverOutcome,
        status: "skipped",
        code: "cancelled",
      });
      markRemainingCancelled(state.outcomes);
      state.failureCodes.push("cancelled");
      return "cancelled";
    }
    const code =
      error instanceof Error && error.message === "stale-evidence"
        ? "stale-evidence"
        : "write-failed";
    replaceOutcome(state.outcomes, state.outcomeIndexes, serverOutcome, {
      ...serverOutcome,
      status: "failed",
      code,
    });
    markLaterPathOutcomesSkipped(state.outcomes, state.outcomeIndexes, record.path);
    state.failureCodes.push(code);
    return "skip-path";
  }
}

function buildDatabaseUpdate(
  record: ReconciliationEngineRecord,
  rating: RatingTargetOutcome | undefined,
  stat: DatabaseStatOutcome | undefined,
): ReconciliationInventoryUpdate | undefined {
  if (rating === undefined && stat === undefined) return undefined;
  const row = record.databaseRows.length === 1 ? record.databaseRows[0] : undefined;
  if (row === undefined) return undefined;
  const expected = {
    rowId: row.id,
    operationId: row.operation_id,
    destPath: row.dest_path,
    rating: row.rating,
    mtime: row.mtime,
    size: row.size,
  };
  return rating !== undefined
    ? {
        expected,
        rating: rating.intended,
        ...(stat === undefined ? {} : { stat: stat.intended }),
      }
    : { expected, stat: stat!.intended };
}

function markDatabaseFailure(
  state: FreshPlanExecutionState,
  outcomes: readonly (RatingTargetOutcome | DatabaseStatOutcome)[],
  code: "stale-evidence" | "write-failed",
): void {
  for (const outcome of outcomes) {
    replaceOutcome(state.outcomes, state.outcomeIndexes, outcome, {
      ...outcome,
      status: "failed",
      code,
    });
  }
  state.failureCodes.push(code);
}

async function executeDatabaseOutcomes(
  options: ReconciliationApplyActionOptions,
  acquisition: ReconciliationAcquisition,
  record: ReconciliationEngineRecord,
  state: FreshPlanExecutionState,
  trustedDatabaseGeneration: ReconciliationDatabaseGeneration,
  authorityLease: ReconciliationDatabaseAuthorityLease | undefined,
  dependencies: ReconciliationActionDependencies,
): Promise<DatabaseExecution> {
  const databaseRating = getRatingOutcome(
    state.outcomes,
    state.outcomeIndexes,
    record.path,
    "database",
  );
  const databaseStat = getDatabaseStatOutcome(state.outcomes, state.outcomeIndexes, record.path);
  const plannedRating = databaseRating?.status === "planned" ? databaseRating : undefined;
  const plannedStat = databaseStat?.status === "planned" ? databaseStat : undefined;
  const planned: (RatingTargetOutcome | DatabaseStatOutcome)[] = [];
  if (plannedRating !== undefined) planned.push(plannedRating);
  if (plannedStat !== undefined) planned.push(plannedStat);
  if (planned.length === 0) {
    return {
      step: "continue",
      databaseGeneration: trustedDatabaseGeneration,
      pendingAuthorityOutcomes: [],
    };
  }

  const update = buildDatabaseUpdate(record, plannedRating, plannedStat);
  if (update === undefined) {
    markDatabaseFailure(state, planned, "stale-evidence");
    return {
      step: "skip-path",
      databaseGeneration: trustedDatabaseGeneration,
      pendingAuthorityOutcomes: [],
    };
  }

  try {
    throwIfCancelled(options.signal);
    if (authorityLease !== undefined) {
      const updated = dependencies.updateReconciliationInventory(authorityLease.connection, update);
      if (updated.status === "stale-evidence") {
        markDatabaseFailure(state, planned, "stale-evidence");
        return {
          step: "skip-path",
          databaseGeneration: trustedDatabaseGeneration,
          pendingAuthorityOutcomes: [],
        };
      }
      return {
        step: "continue",
        databaseGeneration: trustedDatabaseGeneration,
        pendingAuthorityOutcomes: planned,
      };
    }

    const guarded = dependencies.withReconciliationDatabaseWritable(
      acquisition.databasePath,
      trustedDatabaseGeneration,
      (database) => {
        const currentRows = acquireFreshDatabaseRows(
          database,
          record.path,
          options.operationId,
          dependencies,
        );
        if (!databaseRowsMatch(record.databaseRows, currentRows)) {
          return { status: "stale-evidence" as const, rowId: update.expected.rowId };
        }
        return dependencies.updateReconciliationInventory(database, update);
      },
    );
    if (guarded.value.status === "stale-evidence") {
      markDatabaseFailure(state, planned, "stale-evidence");
      return {
        step: "skip-path",
        databaseGeneration: guarded.generation,
        pendingAuthorityOutcomes: [],
      };
    }
    for (const outcome of planned) {
      replaceOutcome(state.outcomes, state.outcomeIndexes, outcome, {
        ...outcome,
        status: "applied",
        code: "applied",
      });
    }
    state.touchedPaths.add(record.path);
    return {
      step: "continue",
      databaseGeneration: guarded.generation,
      pendingAuthorityOutcomes: [],
    };
  } catch {
    if (options.signal?.aborted) {
      markRemainingCancelled(state.outcomes);
      state.failureCodes.push("cancelled");
      return {
        step: "cancelled",
        databaseGeneration: trustedDatabaseGeneration,
        pendingAuthorityOutcomes: [],
      };
    }
    markDatabaseFailure(state, planned, "write-failed");
    return {
      step: "skip-path",
      databaseGeneration: trustedDatabaseGeneration,
      pendingAuthorityOutcomes: [],
    };
  }
}

function markAuthorityDatabaseOutcomesApplied(
  state: FreshPlanExecutionState,
  outcomes: readonly (RatingTargetOutcome | DatabaseStatOutcome)[],
): void {
  for (const outcome of outcomes) {
    replaceOutcome(state.outcomes, state.outcomeIndexes, outcome, {
      ...outcome,
      status: "applied",
      code: "applied",
    });
  }
  if (outcomes.length > 0) state.touchedPaths.add(outcomes[0]!.path);
}

export async function executeFreshReconciliationPlan(
  options: ReconciliationApplyActionOptions,
  acquisition: ReconciliationAcquisition,
  plan: ReconciliationEnginePlan,
  dependencies: ReconciliationActionDependencies,
): Promise<ReconciliationPlanExecution> {
  const outcomes = [...plan.outcomes];
  const recordsByPath = new Map(
    acquisition.report.records.map((record) => [record.path, record] as const),
  );
  if (recordsByPath.size !== acquisition.report.records.length) {
    throw new Error("Duplicate reconciliation report path.");
  }
  const state: FreshPlanExecutionState = {
    outcomes,
    outcomeIndexes: indexOutcomes(outcomes),
    touchedPaths: new Set(),
    failureCodes: [],
  };
  const executionAdapter = dependencies.createAdapter();
  let trustedServerContentVersion = acquisition.serverContentVersion;
  let trustedDatabaseGeneration = acquisition.databaseGeneration;

  for (const path of plan.actionablePaths) {
    if (options.signal?.aborted) {
      state.failureCodes.push("cancelled");
      markRemainingCancelled(state.outcomes);
      break;
    }
    const record = recordsByPath.get(path);
    if (record === undefined) {
      failFirstPlannedOutcome(state.outcomes, state.outcomeIndexes, path, "stale-evidence");
      state.failureCodes.push("stale-evidence");
      continue;
    }

    let authorityLease: ReconciliationDatabaseAuthorityLease | undefined;
    try {
      const guarded = await guardFreshPlanRecord(
        options,
        acquisition,
        plan,
        record,
        state,
        executionAdapter,
        trustedServerContentVersion,
        trustedDatabaseGeneration,
        dependencies,
      );
      trustedServerContentVersion = guarded.serverContentVersion;
      trustedDatabaseGeneration = guarded.databaseGeneration;
      authorityLease = guarded.authorityLease;
    } catch {
      if (options.signal?.aborted) {
        markRemainingCancelled(state.outcomes);
        state.failureCodes.push("cancelled");
        break;
      }
      failFirstPlannedOutcome(state.outcomes, state.outcomeIndexes, path, "stale-evidence");
      state.failureCodes.push("stale-evidence");
      continue;
    }

    try {
      // Mutation order is part of the reconciliation contract.
      const fileStep = await executeFileRatingOutcome(options, record, state, dependencies);
      if (fileStep !== "continue") {
        authorityLease?.rollback();
        if (fileStep === "cancelled") break;
        continue;
      }

      const serverStep = await executeServerRatingOutcome(options, record, state, executionAdapter);
      if (serverStep !== "continue") {
        authorityLease?.rollback();
        if (serverStep === "cancelled") break;
        continue;
      }

      const databaseStep = await executeDatabaseOutcomes(
        options,
        acquisition,
        record,
        state,
        trustedDatabaseGeneration,
        authorityLease,
        dependencies,
      );
      trustedDatabaseGeneration = databaseStep.databaseGeneration;
      if (databaseStep.step !== "continue") {
        authorityLease?.rollback();
        if (databaseStep.step === "cancelled") break;
        continue;
      }

      if (authorityLease !== undefined) {
        throwIfCancelled(options.signal);
        trustedDatabaseGeneration = authorityLease.commit();
        markAuthorityDatabaseOutcomesApplied(state, databaseStep.pendingAuthorityOutcomes);
        authorityLease = undefined;
      }
    } catch {
      authorityLease?.rollback();
      if (options.signal?.aborted) {
        markRemainingCancelled(state.outcomes);
        state.failureCodes.push("cancelled");
        break;
      }
      failFirstPlannedOutcome(state.outcomes, state.outcomeIndexes, path, "write-failed");
      state.failureCodes.push("write-failed");
    } finally {
      authorityLease?.close();
    }
  }

  state.outcomes.sort(compareOutcomeOrder);
  return {
    outcomes: state.outcomes,
    failureCodes: [...new Set(state.failureCodes)],
    touchedPaths: state.touchedPaths,
  };
}
