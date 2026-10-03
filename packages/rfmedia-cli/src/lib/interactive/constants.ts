/**
 * Shared constants for interactive selection components.
 *
 * These constants are used across all interactive ink components
 * for consistent behavior.
 */

/**
 * Delay in milliseconds to allow ink buffer to drain before readline takes over.
 *
 * After Ink exits raw mode, any buffered input (like the Enter keypress that
 * confirmed selection) needs time to be discarded before subsequent readline
 * prompts can safely use stdin.
 */
export const STDIN_CLEANUP_DELAY_MS = 100;

/**
 * Maximum length for filter input.
 *
 * Limits the filter string to prevent excessive memory usage or display issues.
 * 64 characters is sufficient for any reasonable filter.
 */
export const MAX_FILTER_LENGTH = 64;
