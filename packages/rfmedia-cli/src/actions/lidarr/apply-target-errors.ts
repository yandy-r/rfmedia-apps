/** Cancellation detection and safe error presentation for Lidarr apply execution. */

import { LidarrError } from "../../lib/lidarr/errors.js";

/** Returns whether an error or active signal represents cancellation. */
export function isLidarrApplyAbortError(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    ((error instanceof DOMException || error instanceof Error) && error.name === "AbortError")
  );
}

/** Rethrows cancellation while leaving non-cancellation errors to the caller. */
export function throwIfLidarrApplyCancelled(error: unknown, signal?: AbortSignal): void {
  if (isLidarrApplyAbortError(error, signal)) {
    throw signal?.reason ?? error;
  }
}

/** Produces a stable user-facing message without exposing unexpected error details. */
export function safeLidarrApplyErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof LidarrError) return error.message;
  if (isLidarrApplyAbortError(error)) return "Lidarr apply was cancelled";
  return fallback;
}
