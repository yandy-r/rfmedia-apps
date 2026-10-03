/**
 * Queue operations for batch job management.
 *
 * Provides functions to manage the job queue stored in SQLite database.
 * Migrates from legacy JSON file (~/.rfmedia/queue.json) on first access.
 * Jobs are queued for later batch execution with the `queue run` command.
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, rename } from "node:fs/promises";

import { pathExists } from "./filesystem.js";
import { initializeDatabase } from "./db.js";
import { runMigrations } from "./migrations.js";
import { logDebug, logWarn, logInfo } from "./logger.js";
import {
  addJobToDb,
  getJobsFromDb,
  getJobsByTypeFromDb,
  getNextPendingJobFromDb,
  updateJobStatusInDb,
  removeJobFromDb,
  removeJobsByStatusFromDb,
  getQueueStatsFromDb,
} from "./queue-db.js";
import type {
  QueueFile,
  QueueJob,
  QueueJobStatus,
  QueueJobType,
  SerializableCopyOptions,
  SerializableDeleteOptions,
} from "../types/queue.js";
import type { PathEntry, CopySelection, DeleteSelection } from "../types/options.js";
import type { DbConnection } from "../types/db.js";

/**
 * Database connection singleton.
 */
let dbConnection: DbConnection | null = null;

/**
 * Migration flag to ensure we only migrate once per process.
 */
let migrationPerformed = false;

/**
 * Resets the database connection singleton.
 * Closes the existing connection if open and clears state.
 *
 * This is primarily used by tests to ensure database isolation
 * between test cases that use different temporary directories.
 */
export function resetDb(): void {
  if (dbConnection) {
    dbConnection.close();
    dbConnection = null;
  }
  migrationPerformed = false;
}

/**
 * Returns the path to the legacy JSON queue file.
 * Used for migration detection.
 *
 * @returns Path to ~/.rfmedia/queue.json
 */
export function getQueuePath(): string {
  return join(homedir(), ".rfmedia", "queue.json");
}

/**
 * Gets or initializes the database connection.
 * Performs migration from JSON file on first access if needed.
 *
 * @returns Database connection
 */
async function getDb(): Promise<DbConnection> {
  if (!dbConnection) {
    dbConnection = await initializeDatabase();
    await runMigrations(dbConnection);

    // Migrate from JSON file if it exists and we haven't migrated yet
    if (!migrationPerformed) {
      await migrateFromJsonIfNeeded(dbConnection);
      migrationPerformed = true;
    }
  }

  return dbConnection;
}

/**
 * Migrates jobs from JSON file to database if the file exists.
 *
 * @param db - Database connection
 */
async function migrateFromJsonIfNeeded(db: DbConnection): Promise<void> {
  const jsonPath = getQueuePath();

  if (!(await pathExists(jsonPath))) {
    return;
  }

  try {
    logInfo("Migrating queue from JSON file to database...");

    const content = await readFile(jsonPath, "utf-8");
    const data = JSON.parse(content) as QueueFile;

    // Migrate jobs without jobType field (backward compatibility)
    for (const job of data.jobs) {
      if (!job.jobType) {
        job.jobType = "copy"; // Default to copy for existing jobs
      }
    }

    // Insert each job into the database
    for (const job of data.jobs) {
      addJobToDb(db, job); // No selection data in migrated jobs
    }

    // Rename JSON file to indicate migration
    const backupPath = `${jsonPath}.migrated`;
    await rename(jsonPath, backupPath);

    logInfo(
      `Migrated ${data.jobs.length} jobs from JSON to database. JSON file backed up to ${backupPath}`,
    );
  } catch (error) {
    logWarn(
      `Failed to migrate JSON queue file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Legacy function for backward compatibility.
 * Database operations don't need explicit loading.
 *
 * @deprecated Use getJobs() instead
 */
export async function loadQueue(): Promise<QueueFile> {
  const db = await getDb();
  const jobs = getJobsFromDb(db);
  return {
    version: "1",
    updatedAt: new Date().toISOString(),
    jobs,
  };
}

/**
 * Legacy function for backward compatibility.
 * Database operations don't need explicit saving.
 *
 * @deprecated Database changes are automatically persisted
 */
export async function saveQueue(_queue: QueueFile): Promise<void> {
  // No-op: database writes are immediate
  logDebug("saveQueue called (no-op with database backend)");
}

/**
 * Adds a new job to the queue.
 *
 * Supports both single-source and multi-source modes:
 * - Single-source: Pass a string path, creates job with `source` field
 * - Multi-source: Pass PathEntry[], creates job with `sources` field
 *
 * @param sourceOrSources - Source path (string) for single-source mode, or PathEntry[] for multi-source mode (from --paths YAML or interactive selection)
 * @param destination - Destination path for the operation
 * @param options - Serializable copy or delete options
 * @param jobType - Type of job ('copy' or 'delete'), defaults to 'copy' for backward compatibility
 * @param selection - Optional interactive selection (copy or delete)
 * @returns The created job
 */
export async function addJob(
  sourceOrSources: string | PathEntry[],
  destination: string,
  options: SerializableCopyOptions | SerializableDeleteOptions,
  jobType: QueueJobType = "copy",
  selection?: CopySelection | DeleteSelection,
): Promise<QueueJob> {
  const db = await getDb();

  const job: QueueJob = {
    id: randomUUID(),
    jobType,
    addedAt: new Date().toISOString(),
    destination,
    options,
    status: "pending",
    ...(typeof sourceOrSources === "string"
      ? { source: sourceOrSources }
      : { sources: sourceOrSources }),
  };

  addJobToDb(db, job, selection);

  return job;
}

/**
 * Gets jobs from the queue, optionally filtered by status.
 *
 * @param status - Optional status to filter by (undefined returns all jobs)
 * @returns Array of jobs matching the filter
 */
export async function getJobs(status?: QueueJobStatus): Promise<QueueJob[]> {
  const db = await getDb();
  return getJobsFromDb(db, status);
}

/**
 * Gets the next pending job from the queue.
 *
 * @returns The first pending job, or undefined if no pending jobs exist
 */
export async function getNextPendingJob(): Promise<QueueJob | undefined> {
  const db = await getDb();
  return getNextPendingJobFromDb(db);
}

/**
 * Updates the status of a job.
 *
 * Also updates timestamp fields based on the new status:
 * - 'running': Sets startedAt
 * - 'completed' or 'failed': Sets completedAt
 *
 * @param jobId - The job ID to update
 * @param status - The new status
 * @param error - Optional error message (for failed status)
 */
export async function updateJobStatus(
  jobId: string,
  status: QueueJobStatus,
  error?: string,
): Promise<void> {
  const db = await getDb();
  updateJobStatusInDb(db, jobId, status, error);
}

/**
 * Removes a single job from the queue by ID.
 *
 * @param jobId - The job ID to remove
 * @returns true if the job was removed, false if not found
 */
export async function removeJob(jobId: string): Promise<boolean> {
  const db = await getDb();
  return removeJobFromDb(db, jobId);
}

/**
 * Removes jobs from the queue by status.
 *
 * @param status - Status to filter by (undefined removes all jobs)
 * @returns Number of jobs removed
 */
export async function removeJobsByStatus(status?: QueueJobStatus): Promise<number> {
  const db = await getDb();
  return removeJobsByStatusFromDb(db, status);
}

/**
 * Gets statistics about the queue.
 *
 * @returns Counts of jobs by status
 */
export async function getQueueStats(): Promise<Record<QueueJobStatus, number>> {
  const db = await getDb();
  return getQueueStatsFromDb(db);
}

/**
 * Gets jobs from the queue, filtered by job type and optionally by status.
 *
 * @param jobType - Job type to filter by ('copy' or 'delete')
 * @param status - Optional status to filter by (undefined returns all jobs of the type)
 * @returns Array of jobs matching the filters
 */
export async function getJobsByType(
  jobType: QueueJobType,
  status?: QueueJobStatus,
): Promise<QueueJob[]> {
  const db = await getDb();
  return getJobsByTypeFromDb(db, jobType, status);
}
