/**
 * Progress bar utilities for rfmedia CLI copy operations.
 *
 * Provides visual progress bars with ETA calculation using cli-progress.
 * Automatically detects TTY and JSON mode to suppress output when appropriate.
 */

import cliProgress from "cli-progress";
import pc from "picocolors";

import { isJsonMode } from "./logger.js";

/**
 * Options for creating a progress bar.
 */
export interface ProgressBarOptions {
  /** Total number of files to process */
  totalFiles: number;
  /** Total bytes to process (for ETA calculation) */
  totalBytes: number;
  /** Operation name (e.g., artist name) */
  operationName: string;
  /** Force enable/disable progress (undefined = auto-detect) */
  progress?: boolean;
  /** Optional AbortSignal for cancellation */
  signal?: AbortSignal;
}

/**
 * Statistics from the progress bar.
 */
export interface ProgressStats {
  /** Number of files completed */
  completedFiles: number;
  /** Number of bytes completed */
  completedBytes: number;
  /** Elapsed time in milliseconds */
  elapsedMs: number;
  /** Bytes per second rate */
  bytesPerSecond: number;
  /** Estimated time remaining in milliseconds */
  etaMs: number;
}

/**
 * Formats bytes into human-readable string.
 *
 * @param bytes - Number of bytes to format
 * @returns Formatted string like "1.2 GB"
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  const k = 1024;
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
  const value = bytes / Math.pow(k, i);

  // Use appropriate decimal places based on size
  const decimals = i < 2 ? 0 : 1;
  const unit = units[i];

  if (unit === undefined) {
    return `${bytes} B`;
  }

  return `${value.toFixed(decimals)} ${unit}`;
}

/**
 * Formats duration in milliseconds to human-readable string.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted string like "2m 30s" or "45s"
 */
export function formatDuration(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return "--";

  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

/**
 * Checks if progress bar should be displayed.
 *
 * @param options - Options containing progress preference
 * @returns true if progress should be shown
 */
export function isProgressEnabled(options: { progress?: boolean }): boolean {
  // Explicit enable/disable takes precedence
  if (options.progress !== undefined) {
    return options.progress;
  }

  // Auto-detect: disable for JSON mode or non-TTY
  if (isJsonMode()) {
    return false;
  }

  return process.stderr.isTTY ?? false;
}

/**
 * Progress bar for copy operations with ETA calculation.
 *
 * Uses exponential moving average for rate smoothing to provide stable ETA.
 * Displays format: "Copying Artist ████░░░░ 60% | 12/20 files | 1.2 GB/2.0 GB | ETA: 2m 30s"
 */
export class CopyProgressBar {
  private bar: cliProgress.SingleBar | null = null;
  private startTime: number = 0;
  private completedFiles: number = 0;
  private completedBytes: number = 0;
  private smoothedRate: number = 0;
  private lastUpdateTime: number = 0;
  private lastUpdateBytes: number = 0;
  private enabled: boolean = false;
  private aborted: boolean = false;
  private signal?: AbortSignal;

  private readonly totalFiles: number;
  private readonly totalBytes: number;
  private readonly operationName: string;

  /**
   * EMA smoothing factor (0.3 = 30% new data, 70% historical)
   */
  private static readonly EMA_ALPHA = 0.3;

  /**
   * Minimum interval between rate updates (ms) to avoid jitter
   */
  private static readonly MIN_UPDATE_INTERVAL = 500;

  constructor(options: ProgressBarOptions) {
    this.totalFiles = options.totalFiles;
    this.totalBytes = options.totalBytes;
    this.operationName = options.operationName;
    this.enabled = isProgressEnabled(options);
    this.signal = options.signal;

    // Listen for abort signal
    if (this.signal) {
      this.signal.addEventListener("abort", () => {
        this.aborted = true;
        this.stop();
      });
    }
  }

  /**
   * Starts the progress bar display.
   */
  start(): void {
    if (!this.enabled) return;

    this.startTime = Date.now();
    this.lastUpdateTime = this.startTime;
    this.completedFiles = 0;
    this.completedBytes = 0;
    this.smoothedRate = 0;
    this.lastUpdateBytes = 0;

    // Create progress bar with custom format
    this.bar = new cliProgress.SingleBar(
      {
        format: this.formatBar.bind(this),
        hideCursor: true,
        clearOnComplete: false,
        stream: process.stderr,
      },
      cliProgress.Presets.shades_classic,
    );

    this.bar.start(this.totalBytes, 0);
  }

  /**
   * Custom format function for the progress bar.
   */
  private formatBar(
    options: cliProgress.Options,
    params: cliProgress.Params,
    payload: Record<string, unknown>,
  ): string {
    const percentage = Math.min(100, Math.round((params.value / params.total) * 100));
    const barSize = options.barsize ?? 20;
    const filledSize = Math.round(barSize * (percentage / 100));
    const emptySize = barSize - filledSize;

    const filledBar = pc.cyan("█".repeat(filledSize));
    const emptyBar = pc.gray("░".repeat(emptySize));

    const filesProgress = `${this.completedFiles}/${this.totalFiles} files`;
    const bytesProgress = `${formatBytes(this.completedBytes)}/${formatBytes(this.totalBytes)}`;
    const etaStr = this.smoothedRate > 0 ? formatDuration(this.getEtaMs()) : "--";

    // Truncate operation name if too long
    const maxNameLength = 30;
    const name =
      this.operationName.length > maxNameLength
        ? this.operationName.slice(0, maxNameLength - 3) + "..."
        : this.operationName;

    return `Copying ${pc.bold(name)} ${filledBar}${emptyBar} ${pc.yellow(percentage + "%")} | ${filesProgress} | ${bytesProgress} | ETA: ${pc.green(etaStr)}`;
  }

  /**
   * Gets the current estimated time remaining in milliseconds.
   */
  private getEtaMs(): number {
    if (this.smoothedRate <= 0) return Infinity;
    const remainingBytes = this.totalBytes - this.completedBytes;
    return (remainingBytes / this.smoothedRate) * 1000;
  }

  /**
   * Updates rate calculation using exponential moving average.
   */
  private updateRate(): void {
    const now = Date.now();
    const elapsed = now - this.lastUpdateTime;

    // Only update rate if enough time has passed
    if (elapsed < CopyProgressBar.MIN_UPDATE_INTERVAL) {
      return;
    }

    const bytesDelta = this.completedBytes - this.lastUpdateBytes;
    const currentRate = bytesDelta / (elapsed / 1000);

    if (this.smoothedRate === 0) {
      // First measurement - use directly
      this.smoothedRate = currentRate;
    } else {
      // Apply exponential moving average
      this.smoothedRate =
        CopyProgressBar.EMA_ALPHA * currentRate +
        (1 - CopyProgressBar.EMA_ALPHA) * this.smoothedRate;
    }

    this.lastUpdateTime = now;
    this.lastUpdateBytes = this.completedBytes;
  }

  /**
   * Updates the progress bar after completing a file.
   *
   * @param fileBytes - Size of the completed file in bytes
   */
  updateFile(fileBytes: number): void {
    this.completedFiles++;
    this.completedBytes += fileBytes;

    this.updateRate();

    if (this.bar) {
      this.bar.update(this.completedBytes);
    }
  }

  /**
   * Increments progress by a specific byte amount without incrementing file count.
   * Useful for partial file progress or manual byte tracking.
   *
   * @param bytes - Number of bytes to add to progress
   */
  updateBytes(bytes: number): void {
    this.completedBytes += bytes;
    this.updateRate();

    if (this.bar) {
      this.bar.update(this.completedBytes);
    }
  }

  /**
   * Stops the progress bar display.
   * Shows a cancellation message if the operation was aborted.
   */
  stop(): void {
    if (this.bar) {
      this.bar.stop();

      // Show cancellation message if aborted
      if (this.aborted && this.enabled) {
        const message = pc.yellow("\nOperation cancelled - cleaning up...\n");
        process.stderr.write(message);
      }

      this.bar = null;
    }
  }

  /**
   * Gets current progress statistics.
   */
  getStats(): ProgressStats {
    const elapsedMs = Date.now() - this.startTime;

    return {
      completedFiles: this.completedFiles,
      completedBytes: this.completedBytes,
      elapsedMs,
      bytesPerSecond: this.smoothedRate,
      etaMs: this.getEtaMs(),
    };
  }

  /**
   * Checks if the progress bar is enabled.
   */
  isEnabled(): boolean {
    return this.enabled;
  }
}

/**
 * Scans directory and file statistics for progress tracking.
 */
export interface DirectoryStats {
  /** Total number of files */
  fileCount: number;
  /** Total size in bytes */
  totalBytes: number;
}
