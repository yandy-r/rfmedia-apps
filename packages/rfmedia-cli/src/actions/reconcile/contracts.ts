import { lstat } from "node:fs/promises";

import { findAudioFilesNoFollow } from "../../lib/audio.js";
import { createMediaServerAdapter } from "../../lib/adapters/index.js";
import { resolveUndoDatabasePath } from "../../lib/config.js";
import {
  assertReconciliationDatabaseGenerationCurrent,
  closeDatabase,
  getReconciliationInventoryCandidates,
  getReconciliationInventoryCandidatesAtPath,
  openReconciliationDatabaseAuthorityLease,
  openReconciliationDatabaseReadOnly,
  updateReconciliationInventory,
  withReconciliationDatabaseWritable,
} from "../../lib/db.js";
import { getLoadedConfig } from "../../lib/loaded-config.js";
import { accountReconciliationLocalSnapshotBytes } from "../../lib/reconciliation-limits.js";
import { readReconciliationMetadata } from "../../lib/metadata.js";
import { advancePaginationOffset } from "../../lib/pagination.js";
import { confirm, isInteractive } from "../../lib/prompt.js";
import { writeRating } from "../../lib/tag-writer.js";
import type { ReconciliationStrategyFlags } from "../../lib/reconciliation.js";
import type { MediaServerAdapter } from "../../types/media-server.js";

export interface ReconciliationActionBaseOptions {
  readonly sourcePath: string;
  readonly library?: string;
  readonly trackingDatabase?: string;
  readonly operationId?: number;
  readonly workers?: number;
  readonly progress?: boolean;
  readonly signal?: AbortSignal;
}

export interface ReconciliationScanActionOptions extends ReconciliationActionBaseOptions {
  readonly mode: "scan";
}

export interface ReconciliationApplyActionOptions
  extends ReconciliationActionBaseOptions, ReconciliationStrategyFlags {
  readonly mode: "apply";
  readonly execute?: boolean;
  readonly allowPartial?: boolean;
  readonly yes?: boolean;
  readonly machineOutput?: boolean;
  readonly popmEmail?: string;
}

export type ReconciliationActionOptions =
  | ReconciliationScanActionOptions
  | ReconciliationApplyActionOptions;

export interface ReconciliationActionDependencies {
  readonly findAudioFilesNoFollow: typeof findAudioFilesNoFollow;
  readonly lstat: typeof lstat;
  readonly readReconciliationMetadata: typeof readReconciliationMetadata;
  readonly getLoadedConfig: typeof getLoadedConfig;
  readonly resolveUndoDatabasePath: typeof resolveUndoDatabasePath;
  readonly openReconciliationDatabaseReadOnly: typeof openReconciliationDatabaseReadOnly;
  readonly openReconciliationDatabaseAuthorityLease: typeof openReconciliationDatabaseAuthorityLease;
  readonly assertReconciliationDatabaseGenerationCurrent: typeof assertReconciliationDatabaseGenerationCurrent;
  readonly withReconciliationDatabaseWritable: typeof withReconciliationDatabaseWritable;
  readonly closeDatabase: typeof closeDatabase;
  readonly getReconciliationInventoryCandidates: typeof getReconciliationInventoryCandidates;
  readonly getReconciliationInventoryCandidatesAtPath: typeof getReconciliationInventoryCandidatesAtPath;
  readonly updateReconciliationInventory: typeof updateReconciliationInventory;
  readonly createAdapter: () => MediaServerAdapter;
  readonly advancePaginationOffset: typeof advancePaginationOffset;
  readonly accountReconciliationLocalSnapshotBytes: typeof accountReconciliationLocalSnapshotBytes;
  readonly writeRating: typeof writeRating;
  readonly reportProgress: (completed: number, total: number) => void;
  readonly confirm: typeof confirm;
  readonly isInteractive: typeof isInteractive;
}

export const DEFAULT_RECONCILIATION_DEPENDENCIES: ReconciliationActionDependencies = {
  findAudioFilesNoFollow,
  lstat,
  readReconciliationMetadata,
  getLoadedConfig,
  resolveUndoDatabasePath,
  openReconciliationDatabaseReadOnly,
  openReconciliationDatabaseAuthorityLease,
  assertReconciliationDatabaseGenerationCurrent,
  withReconciliationDatabaseWritable,
  closeDatabase,
  getReconciliationInventoryCandidates,
  getReconciliationInventoryCandidatesAtPath,
  updateReconciliationInventory,
  createAdapter: () => {
    const adapter = createMediaServerAdapter({ mode: "required" });
    if (adapter === undefined) throw new Error("Media server adapter is required.");
    return adapter;
  },
  advancePaginationOffset,
  accountReconciliationLocalSnapshotBytes,
  writeRating,
  reportProgress: (completed, total) => {
    process.stderr.write(
      `\rReconciliation metadata: ${completed}/${total}${completed === total ? "\n" : ""}`,
    );
  },
  confirm,
  isInteractive,
};
