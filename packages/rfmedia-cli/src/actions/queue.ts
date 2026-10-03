/**
 * Queue actions for rfmedia CLI.
 *
 * Provides functionality for managing the batch job queue including:
 * - Adding copy jobs to the queue
 * - Listing queued jobs with status filtering
 * - Running all pending jobs in the queue
 * - Clearing jobs from the queue
 *
 * Jobs are stored persistently in SQLite database.
 */

import { Table } from "console-table-printer";
import pc from "picocolors";

import {
  addJob,
  getJobs,
  getQueueStats,
  updateJobStatus,
  removeJob,
  removeJobsByStatus,
} from "../lib/queue.js";
import { initializeDatabase } from "../lib/db.js";
import {
  deserializeDeleteSelectionFromDb,
  deserializeCopySelectionFromDb,
} from "../lib/queue-db.js";
import { logInfo, logSuccess, logDebug, logWarn, output, outputSuccess } from "../lib/logger.js";
import { processInParallel } from "../lib/parallel.js";
import { resolveOptionalScanAdapter } from "../lib/adapters/action-helpers.js";
import {
  getGlobalSignal,
  registerGlobalCleanup,
  unregisterGlobalCleanup,
} from "../lib/signal-handler.js";
import { confirm } from "../lib/prompt.js";
import type {
  QueueAddOptions,
  QueueListOptions,
  QueueRunOptions,
  QueueClearOptions,
  QueueJob,
  QueueJobStatus,
  QueueRunResult,
  QueueClearResult,
  SerializableCopyOptions,
  SerializableDeleteOptions,
} from "../types/queue.js";
import type { CopyOptions, DeleteOptions, PathEntry } from "../types/options.js";
import type { CopyResult, DeleteResult } from "../types/results.js";

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Gets the color name for a job status.
 *
 * @param status - The job status
 * @returns Color name for console-table-printer
 */
function getStatusColor(status: QueueJobStatus): string {
  switch (status) {
    case "pending":
      return "cyan";
    case "running":
      return "blue";
    case "completed":
      return "green";
    case "failed":
      return "red";
    default:
      return "white";
  }
}

/**
 * Truncates a path to a maximum length, keeping the end visible.
 *
 * @param path - The path to truncate
 * @param maxLength - Maximum length of the result
 * @returns Truncated path with leading ellipsis if needed
 */
function truncatePath(path: string, maxLength: number): string {
  if (path.length <= maxLength) {
    return path;
  }
  return "..." + path.slice(-(maxLength - 3));
}

/**
 * Formats an ISO timestamp as a relative time string.
 *
 * @param isoString - ISO 8601 timestamp
 * @returns Human-readable relative time (e.g., "5m ago", "2h ago")
 */
function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) {
    return "just now";
  }
  if (diffMins < 60) {
    return `${diffMins}m ago`;
  }
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  return `${diffDays}d ago`;
}

// ============================================================================
// CONVERSION FUNCTIONS
// ============================================================================

/**
 * Convert CopyOptions to SerializableCopyOptions by removing non-serializable fields.
 *
 * The following fields are excluded:
 * - selection: Contains ReadonlyMap which is not JSON serializable
 * - dryRun: Determined at execution time, not queue time
 *
 * @param options - Full CopyOptions from the command
 * @returns SerializableCopyOptions suitable for JSON storage
 */
export function toSerializableOptions(options: CopyOptions): SerializableCopyOptions {
  const {
    selection: _selection, // Contains ReadonlyMap - not serializable
    dryRun: _dryRun, // Determined at run time
    ...serializable
  } = options;

  return serializable;
}

/**
 * Convert DeleteOptions to SerializableDeleteOptions by removing non-serializable fields.
 *
 * The following fields are excluded:
 * - selection: Contains ReadonlyMap which is not JSON serializable
 * - dryRun: Determined at execution time, not queue time
 *
 * @param options - Full DeleteOptions from the command
 * @returns SerializableDeleteOptions suitable for JSON storage
 */
export function toSerializableDeleteOptions(options: DeleteOptions): SerializableDeleteOptions {
  const {
    selection: _selection, // Contains ReadonlyMap - not serializable
    dryRun: _dryRun, // Determined at run time
    ...serializable
  } = options;

  return serializable;
}

// ============================================================================
// QUEUE ADD ACTION
// ============================================================================

/**
 * Add a copy job to the queue.
 *
 * In dry-run mode, logs what would happen without persisting to the queue.
 * Otherwise, adds the job to the queue file and logs success.
 *
 * Supports both single-source mode (positional source argument) and multi-source
 * mode (sources from --paths YAML or interactive selection).
 *
 * @param source - Source path for the copy operation (single-source mode)
 * @param destination - Destination path for the copy operation
 * @param copyOptions - Full copy options (will be converted to serializable form)
 * @param addOptions - Queue add options (including dry-run flag)
 * @param sources - Optional PathEntry array for multi-source jobs (from --paths YAML or interactive selection)
 * @returns The created job (or mock job in dry-run mode)
 */
export async function executeQueueAdd(
  source: string,
  destination: string,
  copyOptions: CopyOptions,
  addOptions: QueueAddOptions,
  sources?: PathEntry[],
): Promise<QueueJob> {
  const isMultiSource = sources && sources.length > 0;

  if (addOptions.dryRun) {
    const job: QueueJob = {
      id: "dry-run",
      jobType: "copy",
      addedAt: new Date().toISOString(),
      destination,
      options: toSerializableOptions(copyOptions),
      status: "pending",
      ...(isMultiSource ? { sources } : { source }),
    };

    if (isMultiSource) {
      logInfo(`[DRY-RUN] Would add job: ${sources.length} source(s) -> ${destination}`);
    } else {
      logInfo(`[DRY-RUN] Would add job: ${source} -> ${destination}`);
    }
    logInfo(`  Mode: ${copyOptions.mode.type}`);
    return job;
  }

  const serializableOptions = toSerializableOptions(copyOptions);

  // Use multi-source or single-source based on what was provided
  // Pass selection if present (will be serialized to database)
  const job = isMultiSource
    ? await addJob(sources, destination, serializableOptions, "copy", copyOptions.selection)
    : await addJob(source, destination, serializableOptions, "copy", copyOptions.selection);

  outputSuccess(`Added job ${job.id.slice(0, 8)} to queue`);

  return job;
}

/**
 * Add a delete job to the queue.
 *
 * In dry-run mode, logs what would happen without persisting to the queue.
 * Otherwise, adds the job to the queue file and logs success.
 *
 * Supports both single-source mode (positional source argument) and multi-source
 * mode (sources from --paths YAML or interactive selection).
 *
 * @param source - Source path for the delete operation (single-source mode)
 * @param destination - Destination path for the delete operation
 * @param deleteOptions - Full delete options (will be converted to serializable form)
 * @param addOptions - Queue add options (including dry-run flag)
 * @param sources - Optional PathEntry array for multi-source jobs (from --paths YAML or interactive selection)
 * @returns The created job (or mock job in dry-run mode)
 */
export async function executeQueueAddDelete(
  source: string,
  destination: string,
  deleteOptions: DeleteOptions,
  addOptions: QueueAddOptions,
  sources?: PathEntry[],
): Promise<QueueJob> {
  const isMultiSource = sources && sources.length > 0;

  if (addOptions.dryRun) {
    const job: QueueJob = {
      id: "dry-run",
      jobType: "delete",
      addedAt: new Date().toISOString(),
      destination,
      options: toSerializableDeleteOptions(deleteOptions),
      status: "pending",
      ...(isMultiSource ? { sources } : { source }),
    };

    if (isMultiSource) {
      logInfo(`[DRY-RUN] Would add delete job: ${sources.length} source(s) -> ${destination}`);
    } else {
      logInfo(`[DRY-RUN] Would add delete job: ${source} -> ${destination}`);
    }
    logInfo(`  Mode: ${deleteOptions.mode.type}`);
    return job;
  }

  const serializableOptions = toSerializableDeleteOptions(deleteOptions);

  // Use multi-source or single-source based on what was provided
  // Pass selection if present (will be serialized to database)
  const job = isMultiSource
    ? await addJob(sources, destination, serializableOptions, "delete", deleteOptions.selection)
    : await addJob(source, destination, serializableOptions, "delete", deleteOptions.selection);

  outputSuccess(`Added delete job ${job.id.slice(0, 8)} to queue`);

  return job;
}

// ============================================================================
// QUEUE LIST ACTION
// ============================================================================

/**
 * List jobs in the queue with table formatting.
 *
 * Displays:
 * - Summary statistics (pending, running, completed, failed counts)
 * - Table of jobs with ID, status, mode, source, and age
 * - In verbose mode, detailed information for each job
 *
 * @param options - Queue list options (status filter, verbose flag)
 * @returns Array of jobs matching the filter
 */
export async function executeQueueList(options: QueueListOptions): Promise<QueueJob[]> {
  const jobs = await getJobs(options.status);
  const stats = await getQueueStats();

  if (jobs.length === 0) {
    logInfo(options.status ? `No ${options.status} jobs in queue` : "Queue is empty");
    return jobs;
  }

  // Print stats summary
  console.error("");
  console.error(pc.bold("Queue Status"));
  console.error(`  Pending:   ${pc.cyan(String(stats.pending))}`);
  console.error(`  Running:   ${pc.blue(String(stats.running))}`);
  console.error(`  Completed: ${pc.green(String(stats.completed))}`);
  console.error(`  Failed:    ${pc.red(String(stats.failed))}`);
  console.error("");

  // Build table
  const table = new Table({
    columns: [
      { name: "id", title: "ID", alignment: "left" },
      { name: "type", title: "Type", alignment: "left" },
      { name: "status", title: "Status", alignment: "left" },
      { name: "mode", title: "Mode", alignment: "left" },
      { name: "source", title: "Source", alignment: "left" },
      { name: "added", title: "Added", alignment: "right" },
    ],
  });

  for (const job of jobs) {
    const statusColor = getStatusColor(job.status);
    // Show source count for multi-source jobs, otherwise show truncated path
    const sourceDisplay = job.sources
      ? `${job.sources.length} source(s)`
      : truncatePath(job.source ?? "", 40);
    table.addRow(
      {
        id: job.id.slice(0, 8),
        type: job.jobType,
        status: job.status,
        mode: job.options.mode.type,
        source: sourceDisplay,
        added: formatRelativeTime(job.addedAt),
      },
      { color: statusColor },
    );
  }

  console.error(pc.bold("Jobs"));
  console.error(table.render());

  // Verbose mode: show detailed job information
  if (options.verbose) {
    console.error("");
    for (const job of jobs) {
      console.error(pc.bold(`Job ${job.id.slice(0, 8)} (${job.jobType})`));

      // Display source(s) - handle multi-source jobs
      if (job.sources) {
        console.error(`  Sources (${job.sources.length}):`);
        for (const entry of job.sources.slice(0, 5)) {
          // Show first 5
          console.error(`    - ${truncatePath(entry.path, 60)}`);
        }
        if (job.sources.length > 5) {
          console.error(`    ... and ${job.sources.length - 5} more`);
        }
      } else if (job.source) {
        console.error(`  Source:      ${job.source}`);
      }

      // Show source selection criteria if present
      const opts = job.options;
      if (opts.sourceIdx || opts.sourceName || opts.sourceArtist || opts.sourceGroup) {
        console.error("  Selection:");
        if (opts.sourceIdx) {
          console.error(`    Index:   ${opts.sourceIdx}`);
        }
        if (opts.sourceName) {
          console.error(`    Name:    ${opts.sourceName}`);
        }
        if (opts.sourceArtist) {
          console.error(`    Artist:  ${opts.sourceArtist}`);
        }
        if (opts.sourceGroup) {
          console.error(`    Group:   ${opts.sourceGroup}`);
        }
      }

      console.error(`  Destination: ${job.destination}`);
      console.error(`  Mode:        ${job.options.mode.type}`);
      if (job.options.mode.type === "album") {
        const range = job.options.mode.range;
        console.error(
          `  Range:       ${String(range?.start ?? 0).padStart(range?.padWidth ?? 0, "0")}-${String(range?.end ?? 0).padStart(range?.padWidth ?? 0, "0")}`,
        );
      }
      if (job.options.mode.type === "filter") {
        const rating = job.options.mode.rating;
        if (rating.minStars !== undefined) {
          console.error(`  Min Stars:   ${rating.minStars}`);
        }
        if (rating.minRating !== undefined) {
          console.error(`  Min Rating:  ${rating.minRating}`);
        }
      }
      if (job.error) {
        console.error(`  Error:       ${pc.red(job.error)}`);
      }
      console.error("");
    }
  }

  logDebug(`Listed ${jobs.length} job(s)`);

  return jobs;
}

// ============================================================================
// CONVERSION FUNCTIONS (continued)
// ============================================================================

/**
 * Convert SerializableCopyOptions back to CopyOptions for execution.
 *
 * Adds back the dryRun flag which is determined at run time.
 *
 * @param serializable - Serialized options from queue storage
 * @param dryRun - Whether to run in dry-run mode
 * @returns Full CopyOptions for execution
 */
function toCopyOptions(serializable: SerializableCopyOptions, dryRun: boolean): CopyOptions {
  return {
    ...serializable,
    dryRun,
  };
}

/**
 * Convert SerializableDeleteOptions back to DeleteOptions for execution.
 *
 * Adds back the dryRun flag which is determined at run time.
 *
 * @param serializable - Serialized options from queue storage
 * @param dryRun - Whether to run in dry-run mode
 * @returns Full DeleteOptions for execution
 */
function toDeleteOptions(serializable: SerializableDeleteOptions, dryRun: boolean): DeleteOptions {
  return {
    ...serializable,
    dryRun,
  };
}

// ============================================================================
// QUEUE RUN ACTION
// ============================================================================

/**
 * Execute a single queued job.
 *
 * Lazy loads the appropriate action handler based on the job type and mode.
 * Supports both single-source jobs (job.source) and multi-source jobs (job.sources).
 * Loads interactive selections from database if they were saved.
 *
 * @param job - The job to execute
 * @param dryRun - Whether to run in dry-run mode
 * @param _signal - Optional abort signal for cancellation (reserved for future use)
 * @returns Result from the copy or delete action
 */
async function executeJob(
  job: QueueJob,
  dryRun: boolean,
  _signal?: AbortSignal,
): Promise<CopyResult | DeleteResult> {
  // Determine source path (for single-source or fallback for multi-source)
  const sourcePath = job.source ?? job.sources?.[0]?.path ?? "";

  // Load database connection for selection retrieval
  const db = await initializeDatabase();

  if (job.jobType === "delete") {
    // Delete job
    const deleteOptions = toDeleteOptions(job.options as SerializableDeleteOptions, dryRun);

    // Multi-source mode: populate cliSourceEntries from job.sources
    if (job.sources && job.sources.length > 0) {
      deleteOptions.cliSourceEntries = job.sources;
    }

    // Load interactive selection from database if it exists
    const selection = deserializeDeleteSelectionFromDb(db, job.id);
    if (selection) {
      deleteOptions.selection = selection;
      logDebug(
        `Loaded interactive selection for delete job ${job.id}: ${selection.selectedSources.length} sources`,
      );
    }

    // Lazy load the appropriate action handler based on mode type
    if (deleteOptions.mode.type === "album") {
      const { executeAlbumDeleteWithFileInput } = await import("./delete-album.js");
      return executeAlbumDeleteWithFileInput(sourcePath, job.destination, deleteOptions);
    } else {
      const { executeFilterDeleteWithFileInput } = await import("./delete-filter.js");
      return executeFilterDeleteWithFileInput(sourcePath, job.destination, deleteOptions);
    }
  } else {
    // Copy job
    const copyOptions = toCopyOptions(job.options as SerializableCopyOptions, dryRun);

    // Multi-source mode: populate cliSourceEntries from job.sources
    if (job.sources && job.sources.length > 0) {
      copyOptions.cliSourceEntries = job.sources;
    }

    // Load interactive selection from database if it exists
    const selection = deserializeCopySelectionFromDb(db, job.id);
    if (selection) {
      copyOptions.selection = selection;
      logDebug(
        `Loaded interactive selection for copy job ${job.id}: ${selection.selectedSources.length} sources`,
      );
    }

    // Lazy load the appropriate action handler based on mode type
    if (copyOptions.mode.type === "album") {
      const { executeAlbumCopyWithFileInput } = await import("./copy-album.js");
      return executeAlbumCopyWithFileInput(sourcePath, job.destination, copyOptions);
    } else {
      const { executeFilterCopyWithFileInput } = await import("./copy-filter.js");
      return executeFilterCopyWithFileInput(sourcePath, job.destination, copyOptions);
    }
  }
}

/**
 * Run all pending jobs in the queue.
 *
 * Processes jobs in parallel with configurable workers. On completion,
 * successful jobs are removed from the queue, failed jobs remain.
 * Supports graceful interruption via signal handlers.
 *
 * @param options - Run options including workers count and flags
 * @returns Result with completion statistics
 */
export async function executeQueueRun(options: QueueRunOptions): Promise<QueueRunResult> {
  const pendingJobs = await getJobs("pending");

  if (pendingJobs.length === 0) {
    output("No pending jobs in queue");
    return { total: 0, completed: 0, failed: 0, jobs: [] };
  }

  output(`Running ${pendingJobs.length} job(s) with ${options.workers} worker(s)...`);
  output("");

  if (options.dryRun) {
    logInfo("[DRY-RUN] Would execute jobs:");
    for (const job of pendingJobs) {
      const sourceDisplay = job.sources ? `${job.sources.length} source(s)` : (job.source ?? "");
      logInfo(`  - ${job.id.slice(0, 8)}: ${sourceDisplay} -> ${job.destination}`);
    }
    return {
      total: pendingJobs.length,
      completed: 0,
      failed: 0,
      jobs: pendingJobs.map((j) => ({
        id: j.id,
        source: j.source ?? j.sources?.[0]?.path ?? "",
        status: "pending" as const,
      })),
    };
  }

  // Setup graceful interruption
  const signal = getGlobalSignal();
  const localAbortController = new AbortController();

  signal.addEventListener("abort", () => localAbortController.abort());

  registerGlobalCleanup({
    priority: 10,
    name: "queue-run-abort",
    cleanup: () => localAbortController.abort(),
  });

  registerGlobalCleanup({
    priority: 50,
    name: "queue-run-save",
    cleanup: async () => {
      logDebug("Saving queue state...");
      // Queue state is already saved after each job status update
    },
  });

  const results: QueueRunResult = {
    total: pendingJobs.length,
    completed: 0,
    failed: 0,
    jobs: [],
  };

  try {
    // Process jobs in parallel
    const parallelResults = await processInParallel(
      pendingJobs,
      async (job, _index, sig) => {
        try {
          // Mark job as running just-in-time when actually processing
          await updateJobStatus(job.id, "running");
          logDebug(`Starting job ${job.id.slice(0, 8)}`);
          const result = await executeJob(job, options.dryRun, sig);

          await updateJobStatus(job.id, "completed");
          // Keep completed jobs in queue for history/search features
          // Users can manually clear with: queue clear --completed

          return { job, result, success: true };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          await updateJobStatus(job.id, "failed", errorMsg);

          if (!options.continueOnError) {
            throw error;
          }

          return { job, error: errorMsg, success: false };
        }
      },
      {
        workers: options.workers,
        signal: localAbortController.signal,
        onProgress: (completed, total) => {
          logDebug(`Queue progress: ${completed}/${total}`);
        },
      },
    );

    // Aggregate results
    for (const result of parallelResults) {
      if (result.success && result.value) {
        if (result.value.success) {
          results.completed++;
          results.jobs.push({
            id: result.value.job.id,
            source: result.value.job.source ?? result.value.job.sources?.[0]?.path ?? "",
            status: "completed",
          });
        } else {
          results.failed++;
          results.jobs.push({
            id: result.value.job.id,
            source: result.value.job.source ?? result.value.job.sources?.[0]?.path ?? "",
            status: "failed",
            error: result.value.error,
          });
        }
      } else if (result.error) {
        results.failed++;
        const job = pendingJobs[result.index];
        if (job) {
          results.jobs.push({
            id: job.id,
            source: job.source ?? job.sources?.[0]?.path ?? "",
            status: "failed",
            error: result.error.message,
          });
        }
      }
    }

    // Trigger scan if enabled and we have completed jobs.
    if (options.plexScan !== false && results.completed > 0) {
      const { adapter: mediaServerAdapter } = resolveOptionalScanAdapter({
        plexScan: options.plexScan,
      });

      if (mediaServerAdapter?.capabilities.scan) {
        const scanResult = await mediaServerAdapter.scan.trigger();
        if (scanResult.success) {
          logDebug(`Media server scan triggered: ${scanResult.message}`);
        } else {
          logWarn(`Media server scan failed: ${scanResult.message}`);
        }
      }
    }

    outputSuccess(
      `Queue complete: ${results.completed} job(s) completed${results.failed > 0 ? `, ${results.failed} failed` : ""}`,
    );

    return results;
  } finally {
    unregisterGlobalCleanup("queue-run-abort");
    unregisterGlobalCleanup("queue-run-save");
  }
}

// ============================================================================
// QUEUE CLEAR ACTION
// ============================================================================

/**
 * Clear jobs from the queue.
 *
 * Removes jobs matching the specified status, or all jobs if no status filter.
 * Prompts for confirmation unless the force flag is set.
 *
 * @param options - Clear options including status filter and force flag
 * @returns Result with removal statistics
 */
export async function executeQueueClear(options: QueueClearOptions): Promise<QueueClearResult> {
  const jobs = await getJobs(options.status);

  if (jobs.length === 0) {
    logInfo(options.status ? `No ${options.status} jobs to clear` : "Queue is already empty");
    return { removed: 0, remaining: 0 };
  }

  const statusLabel = options.status ?? "all";

  if (options.dryRun) {
    logInfo(`[DRY-RUN] Would remove ${jobs.length} ${statusLabel} job(s)`);
    const remainingCount = options.status ? (await getJobs()).length - jobs.length : 0;
    return { removed: 0, remaining: remainingCount };
  }

  if (!options.force) {
    const confirmed = await confirm(`Remove ${jobs.length} ${statusLabel} job(s)?`);
    if (!confirmed) {
      logInfo("Cancelled");
      return { removed: 0, remaining: (await getJobs()).length };
    }
  }

  const removed = await removeJobsByStatus(options.status);
  const remaining = (await getJobs()).length;

  logSuccess(`Removed ${removed} job(s), ${remaining} remaining`);

  return { removed, remaining };
}
