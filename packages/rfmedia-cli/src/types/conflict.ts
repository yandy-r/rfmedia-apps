/**
 * Type definitions for conflict detection and resolution in rfmedia CLI.
 *
 * These types enable interactive conflict resolution during copy and verify operations.
 * The conflict resolver intercepts file conflicts and provides granular control over
 * skip/overwrite/rename decisions via interactive prompts or CLI strategies.
 *
 * Uses discriminated unions with `type` field for exhaustive type checking,
 * following the `CopyMode` pattern from options.ts.
 */

/**
 * Discriminated union representing different types of file conflicts.
 *
 * Each conflict type provides specific context for resolution decisions:
 * - `exists`: Destination file already exists (may or may not match source)
 * - `size-mismatch`: Destination exists but has different size than expected
 * - `extra`: File exists in destination but has no corresponding source file
 *
 * @example
 * // Type guard usage
 * function handleConflict(conflict: ConflictType) {
 *   switch (conflict.type) {
 *     case 'exists':
 *       console.log(`File exists at ${conflict.destPath}, size: ${conflict.destSize}`);
 *       break;
 *     case 'size-mismatch':
 *       console.log(`Size mismatch: expected ${conflict.expected}, got ${conflict.actual}`);
 *       break;
 *     case 'extra':
 *       console.log(`Extra file: ${conflict.destPath}, size: ${conflict.size}`);
 *       break;
 *   }
 * }
 */
export type ConflictType =
  | {
      /** Discriminator for file existence conflict */
      type: "exists";
      /** Path to the existing destination file */
      destPath: string;
      /** Size of the existing destination file in bytes (undefined if size cannot be read) */
      destSize: number | undefined;
    }
  | {
      /** Discriminator for size mismatch conflict */
      type: "size-mismatch";
      /** Path to the destination file with wrong size */
      destPath: string;
      /** Expected file size in bytes (from source or verification) */
      expected: number;
      /** Actual file size in bytes at destination */
      actual: number;
    }
  | {
      /** Discriminator for extra file conflict */
      type: "extra";
      /** Path to the extra file in destination */
      destPath: string;
      /** Size of the extra file in bytes */
      size: number;
    };

/**
 * Strategy for handling file conflicts during copy/verify operations.
 *
 * Strategies determine how conflicts are resolved without user interaction:
 * - `skip`: Do not overwrite, keep existing file
 * - `overwrite`: Replace existing file with source file
 * - `rename`: Create new file with unique name (e.g., file-002.ext)
 * - `ask`: Prompt user for each conflict (requires interactive TTY)
 *
 * @example
 * // CLI usage
 * // rfmedia copy /source /dest --conflict-strategy=skip
 * // rfmedia verify /source /dest --fix --conflict-strategy=overwrite
 */
export type ConflictStrategy = "skip" | "overwrite" | "rename" | "ask";

/**
 * Context information for a single file conflict.
 *
 * Provides all necessary information to display conflict details to the user
 * and to execute the chosen resolution action.
 *
 * @example
 * const context: ConflictContext = {
 *   sourcePath: '/music/Artist/Album/track.flac',
 *   destPath: '/backup/Artist/Album-001/track.flac',
 *   conflictType: { type: 'exists', destPath: '/backup/Artist/Album-001/track.flac', destSize: 25000000 },
 *   sourceSize: 24500000,
 *   destSize: 25000000,
 * };
 */
export interface ConflictContext {
  /** Absolute path to the source file (may be converted format source) */
  sourcePath: string;
  /** Absolute path to the destination file where conflict occurred */
  destPath: string;
  /** Discriminated union describing the type of conflict */
  conflictType: ConflictType;
  /** Size of the source file in bytes (optional, may not be available for extra files) */
  sourceSize?: number;
  /** Size of the destination file in bytes (optional, for display purposes) */
  destSize?: number;
}

/**
 * Resolution action chosen for a file conflict.
 *
 * Resolutions represent the actual action taken:
 * - `skip`: File was skipped, no action taken
 * - `overwrite`: Existing file was replaced
 * - `rename`: File was copied to a new unique path
 * - `remove`: Extra file was deleted
 * - `keep`: Extra file was kept (not deleted)
 *
 * Note: `remove` and `keep` are specific to `extra` conflict type,
 * while `skip`, `overwrite`, and `rename` apply to `exists` and `size-mismatch` types.
 */
export type ConflictResolution = "skip" | "overwrite" | "rename" | "remove" | "keep";

/**
 * Result of applying a conflict resolution action.
 *
 * Tracks the outcome of each resolution attempt, including success/failure
 * status and any new paths created (for rename operations).
 *
 * @example
 * // Successful rename resolution
 * const result: ConflictResolutionResult = {
 *   context: conflictContext,
 *   resolution: 'rename',
 *   newPath: '/backup/Artist/Album-001/track-002.flac',
 *   success: true,
 * };
 *
 * @example
 * // Failed overwrite resolution
 * const result: ConflictResolutionResult = {
 *   context: conflictContext,
 *   resolution: 'overwrite',
 *   success: false,
 *   error: 'EACCES: permission denied',
 * };
 */
export interface ConflictResolutionResult {
  /** The conflict context that was resolved */
  context: ConflictContext;
  /** The resolution action that was applied */
  resolution: ConflictResolution;
  /** New file path if resolution was 'rename' (undefined for other resolutions) */
  newPath?: string;
  /** Whether the resolution was applied successfully */
  success: boolean;
  /** Error message if the resolution failed */
  error?: string;
}
