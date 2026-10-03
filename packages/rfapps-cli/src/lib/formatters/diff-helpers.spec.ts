import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  formatChangeType,
  formatDirection,
  formatDiffValue,
  formatArrayDiff,
} from "./diff-helpers.js";

// Mock @rfmedia/common with identity-function colors for predictable assertions
vi.mock("@rfmedia/common", () => ({
  colors: {
    green: (s: string) => s,
    red: (s: string) => s,
    yellow: (s: string) => s,
    cyan: (s: string) => s,
    dim: (s: string) => s,
  },
}));

describe("diff-helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("formatChangeType", () => {
    it("should format 'create' with + prefix", () => {
      const result = formatChangeType("create");
      expect(result).toBe("+ create");
    });

    it("should format 'recreate' with ~ prefix", () => {
      const result = formatChangeType("recreate");
      expect(result).toBe("~ recreate");
    });

    it("should format 'update' with ! prefix", () => {
      const result = formatChangeType("update");
      expect(result).toBe("! update");
    });

    it("should format 'delete' with - prefix", () => {
      const result = formatChangeType("delete");
      expect(result).toBe("- delete");
    });

    it("should format 'unchanged' with = prefix", () => {
      const result = formatChangeType("unchanged");
      expect(result).toBe("= unchanged");
    });

    it("should return the raw string for unknown change types", () => {
      const result = formatChangeType("unknown-type");
      expect(result).toBe("unknown-type");
    });
  });

  describe("formatDirection", () => {
    it("should format 'compose_ahead' direction", () => {
      const result = formatDirection("compose_ahead");
      expect(result).toBe("compose ahead");
    });

    it("should format 'container_ahead' direction", () => {
      const result = formatDirection("container_ahead");
      expect(result).toBe("container ahead");
    });

    it("should format 'diverged' direction", () => {
      const result = formatDirection("diverged");
      expect(result).toBe("diverged");
    });
  });

  describe("formatDiffValue", () => {
    it("should format an addition (undefined -> value) with green + prefix", () => {
      const result = formatDiffValue(undefined, "new-value");
      expect(result).toBe("+ new-value");
    });

    it("should format a removal (value -> undefined) with red - prefix", () => {
      const result = formatDiffValue("old-value", undefined);
      expect(result).toBe("- old-value");
    });

    it("should format a change (value1 -> value2) with red/green arrow", () => {
      const result = formatDiffValue("old-value", "new-value");
      // With identity colors: "- old-value" + " → " + "+ new-value"
      expect(result).toBe("- old-value \u2192 + new-value");
    });

    it("should format equal values as dimmed", () => {
      const result = formatDiffValue("same-value", "same-value");
      expect(result).toBe("same-value");
    });

    it("should format both undefined as dimmed (none)", () => {
      const result = formatDiffValue(undefined, undefined);
      expect(result).toBe("(none)");
    });
  });

  describe("formatArrayDiff", () => {
    it("should show (none) when both arrays are empty", () => {
      const result = formatArrayDiff([], []);
      expect(result).toEqual(["(none)"]);
    });

    it("should show (none) when both arrays are undefined", () => {
      const result = formatArrayDiff(undefined, undefined);
      expect(result).toEqual(["(none)"]);
    });

    it("should show added items with green + prefix", () => {
      const result = formatArrayDiff([], ["item1", "item2"]);
      expect(result).toEqual(["+ item1", "+ item2"]);
    });

    it("should show removed items with red - prefix", () => {
      const result = formatArrayDiff(["item1", "item2"], []);
      expect(result).toEqual(["- item1", "- item2"]);
    });

    it("should show unchanged items with dim = prefix", () => {
      const result = formatArrayDiff(["item1"], ["item1"]);
      expect(result).toEqual(["= item1"]);
    });

    it("should show mixed changes with correct prefixes and ordering", () => {
      const result = formatArrayDiff(["removed", "kept"], ["kept", "added"]);
      // Order: removed items first, then unchanged, then added
      expect(result).toEqual(["- removed", "= kept", "+ added"]);
    });

    it("should treat undefined current as empty array", () => {
      const result = formatArrayDiff(undefined, ["item1"]);
      expect(result).toEqual(["+ item1"]);
    });

    it("should treat undefined desired as empty array", () => {
      const result = formatArrayDiff(["item1"], undefined);
      expect(result).toEqual(["- item1"]);
    });

    it("should handle multiple added and removed items", () => {
      const result = formatArrayDiff(["a", "b", "c"], ["b", "d", "e"]);
      // Removed: a, c | Unchanged: b | Added: d, e
      expect(result).toEqual(["- a", "- c", "= b", "+ d", "+ e"]);
    });
  });
});
