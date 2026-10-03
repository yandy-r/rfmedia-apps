/**
 * Progress reporting utilities for rfmedia CLI using listr2.
 *
 * Provides task list wrappers for long-running operations with:
 * - Visual spinners for scanning operations
 * - File count progress (x of y)
 * - Automatic suppression in JSON mode
 */

import { Listr, PRESET_TIMER } from "listr2";
import type { ListrTask } from "listr2";

import { isJsonMode } from "./logger.js";

/**
 * Context type for progress tracking in task lists.
 */
export interface ProgressContext {
  /** Total items to process */
  total: number;
  /** Current item index (0-based) */
  current: number;
  /** Optional message to display */
  message?: string;
}

/**
 * Options for creating a task list.
 */
export interface TaskListOptions<T = ProgressContext> {
  /** Whether to run tasks concurrently (default: false) */
  concurrent?: boolean;
  /** Whether to exit on error (default: true) */
  exitOnError?: boolean;
  /** Initial context object to pass to tasks */
  ctx?: T;
}

/**
 * Creates and runs a listr2 task list.
 *
 * Automatically uses silent renderer when JSON mode is enabled.
 *
 * @param tasks - Array of tasks to execute
 * @param options - Task list options
 * @returns Promise that resolves when all tasks complete
 */
export async function runTasks<T = ProgressContext>(
  tasks: ListrTask<T>[],
  options: TaskListOptions<T> = {},
): Promise<void> {
  const { concurrent = false, exitOnError = true, ctx } = options;

  // Use silent renderer in JSON mode to suppress progress output
  if (isJsonMode()) {
    const listr = new Listr<T, "silent">(tasks, {
      concurrent,
      exitOnError,
      renderer: "silent",
      ctx,
    });
    await listr.run();
    return;
  }

  // Default renderer with timer for non-JSON mode
  const listr = new Listr<T, "default">(tasks, {
    concurrent,
    exitOnError,
    renderer: "default",
    rendererOptions: {
      timer: PRESET_TIMER,
      collapseSubtasks: false,
    },
    ctx,
  });

  await listr.run();
}

/**
 * Creates a simple scanning task with a spinner.
 *
 * @param title - Task title to display
 * @param scanFn - Async function that performs the scanning
 * @returns A listr task configuration
 */
export function createScanTask<T, R>(title: string, scanFn: (ctx: T) => Promise<R>): ListrTask<T> {
  return {
    title,
    task: async (ctx) => {
      await scanFn(ctx);
    },
  };
}

/**
 * Creates a processing task that shows progress (x of y).
 *
 * @param title - Task title to display
 * @param getItems - Function to get items to process from context
 * @param processItem - Async function to process each item
 * @returns A listr task configuration
 */
export function createProcessTask<T, I>(
  title: string,
  getItems: (ctx: T) => I[],
  processItem: (
    item: I,
    index: number,
    ctx: T,
    updateTitle: (title: string) => void,
  ) => Promise<void>,
): ListrTask<T> {
  return {
    title,
    task: async (ctx, task) => {
      const items = getItems(ctx);
      const total = items.length;

      for (let i = 0; i < total; i++) {
        const item = items[i];
        if (item !== undefined) {
          // Update task title with progress
          const updateTitle = (itemTitle: string) => {
            task.title = `${title} (${i + 1}/${total}): ${itemTitle}`;
          };

          await processItem(item, i, ctx, updateTitle);
        }
      }

      // Reset title to show completion
      task.title = `${title} (${total}/${total})`;
    },
  };
}

/**
 * Creates a batch processing task with subtasks for each item.
 *
 * Useful when you want each item to appear as a separate subtask.
 *
 * @param title - Main task title
 * @param getItems - Function to get items from context
 * @param getItemTitle - Function to get display title for each item
 * @param processItem - Async function to process each item
 * @param options - Options for subtask execution
 * @returns A listr task configuration
 */
export function createBatchTask<T, I>(
  title: string,
  getItems: (ctx: T) => I[],
  getItemTitle: (item: I) => string,
  processItem: (item: I, ctx: T) => Promise<void>,
  options: { concurrent?: boolean } = {},
): ListrTask<T> {
  return {
    title,
    task: (ctx, task) => {
      const items = getItems(ctx);

      if (items.length === 0) {
        task.title = `${title} (no items)`;
        return;
      }

      return task.newListr(
        items.map((item) => ({
          title: getItemTitle(item),
          task: async () => {
            await processItem(item, ctx);
          },
        })),
        { concurrent: options.concurrent ?? false },
      );
    },
  };
}

/**
 * Wraps an async operation with a simple spinner task.
 *
 * Convenience function for single-operation progress display.
 * Automatically suppressed in JSON mode.
 *
 * @param title - Title to display while operation runs
 * @param operation - Async operation to execute
 * @returns Result of the operation
 */
export async function withSpinner<T>(title: string, operation: () => Promise<T>): Promise<T> {
  let result: T;

  await runTasks([
    {
      title,
      task: async () => {
        result = await operation();
      },
    },
  ]);

  return result!;
}

/**
 * Wraps an async operation with progress tracking.
 *
 * Shows "title (current/total)" during processing.
 * Automatically suppressed in JSON mode.
 *
 * @param title - Base title for the progress display
 * @param items - Array of items to process
 * @param processItem - Function to process each item (receives item, index, and title updater)
 * @returns Array of results from processing each item
 */
export async function withProgress<T, R>(
  title: string,
  items: T[],
  processItem: (item: T, index: number, updateTitle: (subtitle: string) => void) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];

  await runTasks([
    createProcessTask<{ results: R[] }, T>(
      title,
      () => items,
      async (item, index, ctx, updateTitle) => {
        const result = await processItem(item, index, updateTitle);
        ctx.results.push(result);
      },
    ),
  ]);

  return results;
}
