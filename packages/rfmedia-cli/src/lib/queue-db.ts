/**
 * Queue database operations for batch job management.
 *
 * Provides SQLite-based queue storage with support for interactive selections.
 * Replaces the JSON file-based queue (~/.rfmedia/queue.json) with database storage
 * to preserve non-serializable data structures like ReadonlyMap.
 */

import { logDebug } from "./logger.js";
import type {
  DbConnection,
  DbQueueJob,
  DbQueueJobSource,
  DbQueueJobSelection,
  DbQueueJobSelectedItem,
} from "../types/db.js";
import type {
  QueueJob,
  QueueJobStatus,
  QueueJobType,
  SerializableCopyOptions,
  SerializableDeleteOptions,
} from "../types/queue.js";
import type {
  CopySelection,
  DeleteSelection,
  SourceSelection,
  DeleteSourceSelection,
} from "../types/options.js";

/**
 * Adds a new job to the database queue.
 *
 * The job record, its multi-source entries, and any interactive selections
 * are written in a single transaction so a partially inserted job can never
 * be observed (and multi-row inserts avoid one autocommit per row).
 *
 * @param db - Database connection
 * @param job - Queue job to add
 * @param selection - Optional interactive selection (copy or delete)
 */
export function addJobToDb(
  db: DbConnection,
  job: QueueJob,
  selection?: CopySelection | DeleteSelection,
): void {
  const { id, jobType, addedAt, destination, options, status, source, sources } = job;

  const stmt = db.prepare(`
    INSERT INTO queue_jobs (id, job_type, added_at, destination, options_json, status, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const sourceStmt = db.prepare(`
    INSERT INTO queue_job_sources (
      job_id, source_path, source_index, source_name, source_artist, source_group,
      range_start, range_end, count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertJob = db.transaction(() => {
    // Insert main job record
    stmt.run(id, jobType, addedAt, destination, JSON.stringify(options), status, source ?? null);

    // Insert multi-source entries if present
    if (sources) {
      for (const sourceEntry of sources) {
        sourceStmt.run(
          id,
          sourceEntry.path,
          sourceEntry.sourceIndex ?? null,
          sourceEntry.sourceNames ? JSON.stringify(sourceEntry.sourceNames) : null,
          sourceEntry.sourceArtist ?? null,
          sourceEntry.sourceGroups ? JSON.stringify(sourceEntry.sourceGroups) : null,
          sourceEntry.range?.start ?? null,
          sourceEntry.range?.end ?? null,
          sourceEntry.count ?? null,
        );
      }
    }

    // Serialize interactive selections if present
    if (selection) {
      serializeSelectionToDb(db, id, selection, jobType);
    }
  });

  insertJob();

  logDebug(`Added ${jobType} job to database queue: ${id}`);
  if (sources) {
    logDebug(`Added ${sources.length} source entries for job ${id}`);
  }
}

/**
 * Gets jobs from the database, optionally filtered by status.
 *
 * @param db - Database connection
 * @param status - Optional status filter
 * @returns Array of queue jobs
 */
export function getJobsFromDb(db: DbConnection, status?: QueueJobStatus): QueueJob[] {
  let query = "SELECT * FROM queue_jobs";
  const params: string[] = [];

  if (status !== undefined) {
    query += " WHERE status = ?";
    params.push(status);
  }

  query += " ORDER BY added_at ASC";

  const stmt = db.prepare(query);
  const rows = stmt.all(...params) as DbQueueJob[];

  const sourcesByJob = loadSourcesForJobs(db, rows);
  return rows.map((row) => convertDbJobToQueueJob(row, sourcesByJob.get(row.id) ?? []));
}

/**
 * Gets jobs from the database filtered by job type and optionally by status.
 *
 * @param db - Database connection
 * @param jobType - Job type filter
 * @param status - Optional status filter
 * @returns Array of queue jobs
 */
export function getJobsByTypeFromDb(
  db: DbConnection,
  jobType: QueueJobType,
  status?: QueueJobStatus,
): QueueJob[] {
  let query = "SELECT * FROM queue_jobs WHERE job_type = ?";
  const params: (string | QueueJobType)[] = [jobType];

  if (status !== undefined) {
    query += " AND status = ?";
    params.push(status);
  }

  query += " ORDER BY added_at ASC";

  const stmt = db.prepare(query);
  const rows = stmt.all(...params) as DbQueueJob[];

  const sourcesByJob = loadSourcesForJobs(db, rows);
  return rows.map((row) => convertDbJobToQueueJob(row, sourcesByJob.get(row.id) ?? []));
}

/**
 * Gets the next pending job from the database.
 *
 * @param db - Database connection
 * @returns The first pending job, or undefined if none exist
 */
export function getNextPendingJobFromDb(db: DbConnection): QueueJob | undefined {
  const stmt = db.prepare(`
    SELECT * FROM queue_jobs
    WHERE status = 'pending'
    ORDER BY added_at ASC
    LIMIT 1
  `);

  const row = stmt.get() as DbQueueJob | undefined;
  if (!row) {
    return undefined;
  }

  const sourcesByJob = loadSourcesForJobs(db, [row]);
  return convertDbJobToQueueJob(row, sourcesByJob.get(row.id) ?? []);
}

/**
 * Updates the status of a job in the database.
 *
 * Also updates timestamp fields based on the new status:
 * - 'running': Sets started_at
 * - 'completed' or 'failed': Sets completed_at
 *
 * @param db - Database connection
 * @param jobId - Job ID to update
 * @param status - New status
 * @param error - Optional error message (for failed status)
 */
export function updateJobStatusInDb(
  db: DbConnection,
  jobId: string,
  status: QueueJobStatus,
  error?: string,
): void {
  const now = new Date().toISOString();
  const updates: string[] = ["status = ?"];
  const values: (string | null)[] = [status];

  if (status === "running") {
    updates.push("started_at = ?");
    values.push(now);
  } else if (status === "completed" || status === "failed") {
    updates.push("completed_at = ?");
    values.push(now);
  }

  if (error) {
    updates.push("error = ?");
    values.push(error);
  }

  const stmt = db.prepare(`
    UPDATE queue_jobs
    SET ${updates.join(", ")}
    WHERE id = ?
  `);

  const result = stmt.run(...values, jobId);

  if (result.changes === 0) {
    throw new Error(`Job not found: ${jobId}`);
  }

  logDebug(`Updated job ${jobId} status to: ${status}`);
}

/**
 * Removes a job from the database by ID.
 * CASCADE deletes handle removal of related sources, selections, and items.
 *
 * @param db - Database connection
 * @param jobId - Job ID to remove
 * @returns true if the job was removed, false if not found
 */
export function removeJobFromDb(db: DbConnection, jobId: string): boolean {
  const stmt = db.prepare("DELETE FROM queue_jobs WHERE id = ?");
  const result = stmt.run(jobId);

  const removed = result.changes > 0;
  if (removed) {
    logDebug(`Removed job ${jobId} from database queue`);
  }

  return removed;
}

/**
 * Removes jobs from the database by status.
 *
 * @param db - Database connection
 * @param status - Status filter (undefined removes all jobs)
 * @returns Number of jobs removed
 */
export function removeJobsByStatusFromDb(db: DbConnection, status?: QueueJobStatus): number {
  let stmt;

  if (status === undefined) {
    stmt = db.prepare("DELETE FROM queue_jobs");
  } else {
    stmt = db.prepare("DELETE FROM queue_jobs WHERE status = ?");
  }

  const result = status === undefined ? stmt.run() : stmt.run(status);
  const removed = result.changes;

  if (removed > 0) {
    logDebug(`Removed ${removed} jobs from database queue`);
  }

  return removed;
}

/**
 * Gets queue statistics from the database.
 *
 * @param db - Database connection
 * @returns Counts of jobs by status
 */
export function getQueueStatsFromDb(db: DbConnection): Record<QueueJobStatus, number> {
  const stmt = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM queue_jobs
    GROUP BY status
  `);

  const rows = stmt.all() as Array<{ status: QueueJobStatus; count: number }>;
  const stats: Record<QueueJobStatus, number> = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
  };

  for (const row of rows) {
    stats[row.status] = row.count;
  }

  return stats;
}

/**
 * Serializes interactive selection to database tables.
 * Converts ReadonlyMap to normalized table rows for storage.
 *
 * @param db - Database connection
 * @param jobId - Job ID
 * @param selection - Copy or delete selection
 * @param selectionType - Type of selection ('copy' or 'delete')
 */
export function serializeSelectionToDb(
  db: DbConnection,
  jobId: string,
  selection: CopySelection | DeleteSelection,
  selectionType: "copy" | "delete",
): void {
  const selectionStmt = db.prepare(`
    INSERT INTO queue_job_selections (job_id, source_path, selection_type, level)
    VALUES (?, ?, ?, ?)
  `);

  const itemStmt = db.prepare(`
    INSERT INTO queue_job_selected_items (selection_id, item_type, item_value)
    VALUES (?, ?, ?)
  `);

  let count = 0;

  for (const [sourcePath, sourceSelection] of selection.sourceSelections) {
    // Insert selection record
    const level =
      "level" in sourceSelection && sourceSelection.level ? sourceSelection.level : null;
    const result = selectionStmt.run(jobId, sourcePath, selectionType, level);
    const selectionId = Number(result.lastInsertRowid);

    // Insert selected items based on selection type
    if (selectionType === "delete") {
      const deleteSelection = sourceSelection as DeleteSourceSelection;
      if (deleteSelection.selectedSuffixes) {
        for (const suffix of deleteSelection.selectedSuffixes) {
          itemStmt.run(selectionId, "suffix", suffix);
          count++;
        }
      }
    } else {
      // Copy selection
      const copySelection = sourceSelection as SourceSelection;
      if (copySelection.selectedAlbums) {
        for (const album of copySelection.selectedAlbums) {
          itemStmt.run(selectionId, "album", album);
          count++;
        }
      }
      if (copySelection.selectedTracks) {
        for (const track of copySelection.selectedTracks) {
          itemStmt.run(selectionId, "track", track);
          count++;
        }
      }
    }
  }

  logDebug(
    `Serialized ${selection.sourceSelections.size} selections with ${count} items for job ${jobId}`,
  );
}

/**
 * Deserializes delete selection from database tables.
 * Reconstructs ReadonlyMap from normalized table rows.
 *
 * @param db - Database connection
 * @param jobId - Job ID
 * @returns Delete selection or undefined if none exists
 */
export function deserializeDeleteSelectionFromDb(
  db: DbConnection,
  jobId: string,
): DeleteSelection | undefined {
  const selectionsStmt = db.prepare(`
    SELECT * FROM queue_job_selections
    WHERE job_id = ? AND selection_type = 'delete'
  `);

  const selections = selectionsStmt.all(jobId) as DbQueueJobSelection[];
  if (selections.length === 0) {
    return undefined;
  }

  const itemsStmt = db.prepare(`
    SELECT item_type, item_value
    FROM queue_job_selected_items
    WHERE selection_id = ?
  `);

  const sourceSelections = new Map<string, DeleteSourceSelection>();

  for (const sel of selections) {
    const items = itemsStmt.all(sel.id) as DbQueueJobSelectedItem[];
    const selectedSuffixes = items.filter((i) => i.item_type === "suffix").map((i) => i.item_value);

    sourceSelections.set(sel.source_path, {
      sourcePath: sel.source_path,
      selectedSuffixes,
    });
  }

  logDebug(`Deserialized delete selection for job ${jobId}: ${sourceSelections.size} sources`);

  return {
    selectedSources: Array.from(sourceSelections.keys()),
    sourceSelections: sourceSelections as ReadonlyMap<string, DeleteSourceSelection>,
  };
}

/**
 * Deserializes copy selection from database tables.
 * Reconstructs ReadonlyMap from normalized table rows.
 *
 * @param db - Database connection
 * @param jobId - Job ID
 * @returns Copy selection or undefined if none exists
 */
export function deserializeCopySelectionFromDb(
  db: DbConnection,
  jobId: string,
): CopySelection | undefined {
  const selectionsStmt = db.prepare(`
    SELECT * FROM queue_job_selections
    WHERE job_id = ? AND selection_type = 'copy'
  `);

  const selections = selectionsStmt.all(jobId) as DbQueueJobSelection[];
  if (selections.length === 0) {
    return undefined;
  }

  const itemsStmt = db.prepare(`
    SELECT item_type, item_value
    FROM queue_job_selected_items
    WHERE selection_id = ?
  `);

  const sourceSelections = new Map<string, SourceSelection>();

  for (const sel of selections) {
    const items = itemsStmt.all(sel.id) as DbQueueJobSelectedItem[];
    const selectedAlbums = items.filter((i) => i.item_type === "album").map((i) => i.item_value);
    const selectedTracks = items.filter((i) => i.item_type === "track").map((i) => i.item_value);

    sourceSelections.set(sel.source_path, {
      sourcePath: sel.source_path,
      level: (sel.level ?? "album") as "album" | "track",
      selectedAlbums: selectedAlbums.length > 0 ? selectedAlbums : undefined,
      selectedTracks: selectedTracks.length > 0 ? selectedTracks : undefined,
    });
  }

  logDebug(`Deserialized copy selection for job ${jobId}: ${sourceSelections.size} sources`);

  return {
    selectedSources: Array.from(sourceSelections.keys()),
    sourceSelections: sourceSelections as ReadonlyMap<string, SourceSelection>,
  };
}

/**
 * Maximum number of bound parameters used per batched IN (...) query.
 * Kept well below SQLite's compile-time variable limit.
 */
const MAX_BATCH_PARAMS = 500;

/**
 * Loads multi-source entries for a set of jobs in batched queries.
 *
 * Replaces the previous one-query-per-job pattern (N+1) with IN (...)
 * lookups over chunks of job IDs (#112).
 *
 * @param db - Database connection
 * @param rows - Job rows to load sources for
 * @returns Map of job ID to its source entries (insertion order preserved)
 */
function loadSourcesForJobs(db: DbConnection, rows: DbQueueJob[]): Map<string, DbQueueJobSource[]> {
  const sourcesByJob = new Map<string, DbQueueJobSource[]>();
  if (rows.length === 0) {
    return sourcesByJob;
  }

  for (let offset = 0; offset < rows.length; offset += MAX_BATCH_PARAMS) {
    const chunk = rows.slice(offset, offset + MAX_BATCH_PARAMS);
    const placeholders = chunk.map(() => "?").join(",");
    const stmt = db.prepare(`
      SELECT * FROM queue_job_sources
      WHERE job_id IN (${placeholders})
      ORDER BY id
    `);

    const sources = stmt.all(...chunk.map((row) => row.id)) as DbQueueJobSource[];
    for (const source of sources) {
      const existing = sourcesByJob.get(source.job_id);
      if (existing) {
        existing.push(source);
      } else {
        sourcesByJob.set(source.job_id, [source]);
      }
    }
  }

  return sourcesByJob;
}

/**
 * Parses a stored multi-value column (source_name / source_group) into a
 * string array.
 *
 * Values are persisted as JSON arrays so entries containing commas survive
 * the round-trip. Rows written by older versions used comma-delimited
 * strings, so anything that does not parse as a JSON string array falls back
 * to comma splitting for compatibility.
 *
 * @param value - Raw column value (nullable)
 * @returns Parsed string array, or undefined if the column is empty
 */
function parseStringArrayColumn(value: string | null): string[] | undefined {
  if (!value) {
    return undefined;
  }

  if (value.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        return parsed;
      }
    } catch {
      // Not valid JSON - treat as a legacy comma-delimited value below
    }
  }

  return value.split(",");
}

/**
 * Converts database queue job record to QueueJob type.
 *
 * @param row - Database row
 * @param sources - Pre-loaded multi-source entries for this job (may be empty)
 * @returns Queue job
 */
function convertDbJobToQueueJob(row: DbQueueJob, sources: DbQueueJobSource[]): QueueJob {
  const job: QueueJob = {
    id: row.id,
    jobType: row.job_type,
    addedAt: row.added_at,
    destination: row.destination,
    options: JSON.parse(row.options_json) as SerializableCopyOptions | SerializableDeleteOptions,
    status: row.status,
  };

  // Add single source if present
  if (row.source) {
    job.source = row.source;
  }

  if (sources.length > 0) {
    job.sources = sources.map((s) => ({
      path: s.source_path,
      sourceIndex: s.source_index ?? undefined,
      sourceNames: parseStringArrayColumn(s.source_name),
      sourceArtist: s.source_artist ?? undefined,
      sourceGroups: parseStringArrayColumn(s.source_group),
      range:
        s.range_start !== null && s.range_end !== null
          ? { start: s.range_start, end: s.range_end, padWidth: 3 }
          : undefined,
      count: s.count ?? undefined,
    }));
  }

  // Add optional timestamp fields
  if (row.started_at) {
    job.startedAt = row.started_at;
  }
  if (row.completed_at) {
    job.completedAt = row.completed_at;
  }
  if (row.error) {
    job.error = row.error;
  }

  return job;
}
