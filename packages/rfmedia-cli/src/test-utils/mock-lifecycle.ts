import { vi } from "vitest";

/**
 * Clears Vitest mock call history without resetting implementations.
 *
 * Prefer this over `vi.resetAllMocks()` in lifecycle hooks when mocks are
 * created with `vi.hoisted()` and should keep their default behavior.
 */
export function clearMocksPreservingImplementations(): void {
  vi.clearAllMocks();
}
