import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isInteractiveEnvironment, shouldShowInteractiveSelection } from "./interactive-check.js";
import * as common from "@rfmedia/common";

// Mock @rfmedia/common
vi.mock("@rfmedia/common", () => ({
  isJsonMode: vi.fn(),
}));

describe("Interactive Check", () => {
  // Store original process.stdin.isTTY
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalIsTTY = process.stdin.isTTY;
  });

  afterEach(() => {
    // Restore original value
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
  });

  describe("isInteractiveEnvironment", () => {
    it("should return true when TTY and not JSON mode", () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        writable: true,
        configurable: true,
      });
      vi.mocked(common.isJsonMode).mockReturnValue(false);

      expect(isInteractiveEnvironment()).toBe(true);
    });

    it("should return false when not TTY", () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: false,
        writable: true,
        configurable: true,
      });
      vi.mocked(common.isJsonMode).mockReturnValue(false);

      expect(isInteractiveEnvironment()).toBe(false);
    });

    it("should return false when TTY is undefined (non-TTY)", () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        writable: true,
        configurable: true,
      });
      vi.mocked(common.isJsonMode).mockReturnValue(false);

      expect(isInteractiveEnvironment()).toBe(false);
    });

    it("should return false when JSON mode is enabled", () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        writable: true,
        configurable: true,
      });
      vi.mocked(common.isJsonMode).mockReturnValue(true);

      expect(isInteractiveEnvironment()).toBe(false);
    });

    it("should return false when not TTY and JSON mode enabled", () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: false,
        writable: true,
        configurable: true,
      });
      vi.mocked(common.isJsonMode).mockReturnValue(true);

      expect(isInteractiveEnvironment()).toBe(false);
    });
  });

  describe("shouldShowInteractiveSelection", () => {
    // Helper to set up TTY environment
    function setupInteractiveEnv(): void {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        writable: true,
        configurable: true,
      });
      vi.mocked(common.isJsonMode).mockReturnValue(false);
    }

    function setupNonInteractiveEnv(): void {
      Object.defineProperty(process.stdin, "isTTY", {
        value: false,
        writable: true,
        configurable: true,
      });
      vi.mocked(common.isJsonMode).mockReturnValue(false);
    }

    it("should return true when no service flags and interactive environment", () => {
      setupInteractiveEnv();

      expect(shouldShowInteractiveSelection({})).toBe(true);
    });

    it("should return true when options are explicitly undefined", () => {
      setupInteractiveEnv();

      expect(
        shouldShowInteractiveSelection({
          service: undefined,
          services: undefined,
          group: undefined,
          yes: undefined,
        }),
      ).toBe(true);
    });

    it("should return false when -s (service) is provided", () => {
      setupInteractiveEnv();

      expect(shouldShowInteractiveSelection({ service: "traefik" })).toBe(false);
    });

    it("should return false when --services is provided with values", () => {
      setupInteractiveEnv();

      expect(shouldShowInteractiveSelection({ services: ["traefik", "plex"] })).toBe(false);
    });

    it("should return true when --services is an empty array", () => {
      setupInteractiveEnv();

      // Empty array means no services specified, should show interactive
      expect(shouldShowInteractiveSelection({ services: [] })).toBe(true);
    });

    it("should return false when -g (group) is provided", () => {
      setupInteractiveEnv();

      expect(shouldShowInteractiveSelection({ group: "media-stack" })).toBe(false);
    });

    it("should return false when --yes is provided", () => {
      setupInteractiveEnv();

      expect(shouldShowInteractiveSelection({ yes: true })).toBe(false);
    });

    it("should return true when --yes is false", () => {
      setupInteractiveEnv();

      expect(shouldShowInteractiveSelection({ yes: false })).toBe(true);
    });

    it("should return false when not in interactive environment (non-TTY)", () => {
      setupNonInteractiveEnv();

      expect(shouldShowInteractiveSelection({})).toBe(false);
    });

    it("should return false when JSON mode is enabled", () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        writable: true,
        configurable: true,
      });
      vi.mocked(common.isJsonMode).mockReturnValue(true);

      expect(shouldShowInteractiveSelection({})).toBe(false);
    });

    it("should return false when multiple targeting options are provided", () => {
      setupInteractiveEnv();

      // Even if multiple targeting options are provided, still returns false
      expect(
        shouldShowInteractiveSelection({
          service: "traefik",
          group: "media-stack",
        }),
      ).toBe(false);
    });

    it("should return false when service targeting with --yes", () => {
      setupInteractiveEnv();

      // Both service and yes are provided
      expect(
        shouldShowInteractiveSelection({
          service: "traefik",
          yes: true,
        }),
      ).toBe(false);
    });

    it("should return false when --tag alone is provided", () => {
      setupInteractiveEnv();

      // --tag is a targeting flag: without this, `rfapps deploy --tag "media/**"` pops
      // the Ink multi-select on a TTY.
      expect(shouldShowInteractiveSelection({ tag: ["media/**"] })).toBe(false);
    });

    it("should return false when --tag is combined with other targeting flags", () => {
      setupInteractiveEnv();

      expect(
        shouldShowInteractiveSelection({
          service: "plex",
          tag: ["media/**"],
        }),
      ).toBe(false);
    });

    it("should return true when --tag is an empty array", () => {
      setupInteractiveEnv();

      // Commander must never default the collector to `[]`; an empty array is absent.
      expect(shouldShowInteractiveSelection({ tag: [] })).toBe(true);
    });
  });
});
