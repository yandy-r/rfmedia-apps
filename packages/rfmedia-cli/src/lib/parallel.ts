/**
 * Parallel processing utilities for rfmedia CLI.
 *
 * Provides concurrency-limited task execution for file operations.
 * Uses p-limit to prevent overwhelming the filesystem with too many
 * concurrent operations (EMFILE prevention).
 */

import os from "node:os";
import pLimit from "p-limit";

import { logDebug } from "./logger.js";

/**
 * Maximum allowed workers to prevent resource exhaustion.
 */
const MAX_WORKERS = 8;

/**
 * Minimum workers (always at least one).
 */
const MIN_WORKERS = 1;

/**
 * Result of a parallel operation that may have succeeded or failed.
 */
export interface ParallelResult<T> {
  /** Whether the operation succeeded */
  success: boolean;
  /** The result value if successful */
  value?: T;
  /** The error if failed */
  error?: Error;
  /** Index of the item in the original array */
  index: number;
}

/**
 * Options for parallel processing.
 */
export interface ParallelOptions {
  /** Number of concurrent workers */
  workers: number;
  /** Callback for progress updates */
  onProgress?: (completed: number, total: number) => void;
  /** Optional AbortSignal for cancellation */
  signal?: AbortSignal;
}

/**
 * Gets the default number of workers based on CPU cores.
 *
 * Uses half of available CPU cores, with a minimum of 1 and maximum of 8.
 * This is conservative to avoid overwhelming the filesystem with too many
 * concurrent file operations.
 *
 * @returns Default worker count
 */
export function getDefaultWorkers(): number {
  const cpuCount = os.cpus().length;
  const defaultWorkers = Math.max(MIN_WORKERS, Math.floor(cpuCount / 2));
  return Math.min(defaultWorkers, MAX_WORKERS);
}

/**
 * Validates and clamps worker count to valid range.
 *
 * @param workers - Requested worker count
 * @returns Validated worker count between MIN_WORKERS and MAX_WORKERS
 */
export function validateWorkers(workers: number): number {
  if (workers < MIN_WORKERS) {
    logDebug(`Worker count ${workers} below minimum, using ${MIN_WORKERS}`);
    return MIN_WORKERS;
  }
  if (workers > MAX_WORKERS) {
    logDebug(`Worker count ${workers} above maximum, using ${MAX_WORKERS}`);
    return MAX_WORKERS;
  }
  return workers;
}

/**
 * Creates a concurrency-limited task queue.
 *
 * @param workers - Number of concurrent workers
 * @returns A p-limit instance for queueing tasks
 */
export function createTaskQueue(workers: number): ReturnType<typeof pLimit> {
  const validatedWorkers = validateWorkers(workers);
  logDebug(`Creating task queue with ${validatedWorkers} workers`);
  return pLimit(validatedWorkers);
}

/**
 * Processes items in parallel with concurrency limiting.
 *
 * Collects all errors without stopping on first failure, allowing all
 * operations to complete. Use the returned results to check for failures.
 * Supports graceful cancellation via AbortSignal.
 *
 * @param items - Array of items to process
 * @param processor - Async function to process each item (receives signal as third parameter)
 * @param options - Parallel processing options
 * @returns Array of results (in same order as input items)
 */
export async function processInParallel<T, R>(
  items: T[],
  processor: (item: T, index: number, signal?: AbortSignal) => Promise<R>,
  options: ParallelOptions,
): Promise<ParallelResult<R>[]> {
  const { workers, onProgress, signal } = options;
  const limit = createTaskQueue(workers);
  const total = items.length;
  let completed = 0;

  // Check if already aborted before starting
  if (signal?.aborted) {
    logDebug("Parallel processing aborted before start");
    return items.map((_, index) => ({
      success: false,
      error: new Error("Operation aborted"),
      index,
    }));
  }

  logDebug(`Starting parallel processing: ${total} items with ${validateWorkers(workers)} workers`);

  const tasks = items.map((item, index) =>
    limit(async (): Promise<ParallelResult<R>> => {
      // Check if aborted before processing this item
      if (signal?.aborted) {
        completed++;
        onProgress?.(completed, total);
        return { success: false, error: new Error("Operation aborted"), index };
      }

      try {
        const value = await processor(item, index, signal);
        completed++;
        onProgress?.(completed, total);
        return { success: true, value, index };
      } catch (err) {
        completed++;
        onProgress?.(completed, total);
        const error = err instanceof Error ? err : new Error(String(err));
        return { success: false, error, index };
      }
    }),
  );

  // Use allSettled for better abort handling
  const settledResults = await Promise.allSettled(tasks);
  const results = settledResults.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    // Promise rejection (shouldn't happen with our error handling, but handle it)
    return {
      success: false,
      error: result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
      index,
    } as ParallelResult<R>;
  });

  logDebug(`Parallel processing complete: ${completed}/${total} items processed`);

  return results;
}

/**
 * Processes items in parallel, returning only successful results.
 *
 * Similar to processInParallel but filters out failures and returns
 * only the successful values. Failed operations are collected separately.
 * Supports graceful cancellation via AbortSignal.
 *
 * @param items - Array of items to process
 * @param processor - Async function to process each item (receives signal as third parameter)
 * @param options - Parallel processing options
 * @returns Object with successful values and failed items
 */
export async function processInParallelWithFailures<T, R>(
  items: T[],
  processor: (item: T, index: number, signal?: AbortSignal) => Promise<R>,
  options: ParallelOptions,
): Promise<{
  values: R[];
  failures: Array<{ item: T; error: Error; index: number }>;
}> {
  const results = await processInParallel(items, processor, options);

  const values: R[] = [];
  const failures: Array<{ item: T; error: Error; index: number }> = [];

  for (const result of results) {
    if (result.success && result.value !== undefined) {
      values.push(result.value);
    } else if (!result.success && result.error) {
      const item = items[result.index];
      if (item !== undefined) {
        failures.push({ item, error: result.error, index: result.index });
      }
    }
  }

  return { values, failures };
}

/**
 * Maps items in parallel with concurrency limiting.
 *
 * Similar to Array.map but processes items concurrently with a limit.
 * Throws on first error encountered. Supports graceful cancellation via AbortSignal.
 *
 * @param items - Array of items to map
 * @param mapper - Async function to transform each item (receives signal as third parameter)
 * @param workers - Number of concurrent workers
 * @param signal - Optional AbortSignal for cancellation
 * @returns Array of mapped results (in same order as input)
 */
export async function mapInParallel<T, R>(
  items: T[],
  mapper: (item: T, index: number, signal?: AbortSignal) => Promise<R>,
  workers: number,
  signal?: AbortSignal,
): Promise<R[]> {
  const limit = createTaskQueue(workers);

  // Check if already aborted before starting
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }

  const tasks = items.map((item, index) =>
    limit(async () => {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      return mapper(item, index, signal);
    }),
  );

  return Promise.all(tasks);
}
