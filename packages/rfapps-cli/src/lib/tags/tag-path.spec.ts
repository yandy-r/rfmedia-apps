import { describe, it, expect } from "vitest";
import { TAG_MAX_DEPTH, TAG_MAX_LENGTH, TAG_MAX_SEGMENT_LENGTH } from "../../types/tags.js";
import { ConfigValidationError, InvalidArgumentError } from "../errors.js";
import {
  compareTags,
  invalidSegmentReason,
  isValidTagSegment,
  normalizeTag,
  segmentTooLongReason,
  tagAncestors,
} from "./tag-path.js";

const CONFIG_SOURCE = "/srv/rfmedia-apps/rfapps.config.yaml";

describe("tag-path", () => {
  describe("normalizeTag - canonicalization (design 3.2)", () => {
    it("should return the canonical form unchanged", () => {
      expect(normalizeTag("infrastructure/core/networking")).toBe("infrastructure/core/networking");
    });

    it("should be idempotent", () => {
      const once = normalizeTag("  Media/Streaming/ ");
      const twice = normalizeTag(once);

      expect(once).toBe("media/streaming");
      expect(twice).toBe(once);
    });

    it("should trim surrounding whitespace", () => {
      expect(normalizeTag("   media/streaming\t")).toBe("media/streaming");
    });

    it("should fold case to lowercase", () => {
      expect(normalizeTag("MEDIA/Streaming")).toBe("media/streaming");
      expect(normalizeTag("Infrastructure/CORE")).toBe("infrastructure/core");
    });

    it("should strip a single leading slash", () => {
      expect(normalizeTag("/media/streaming")).toBe("media/streaming");
    });

    it("should strip a single trailing slash", () => {
      expect(normalizeTag("media/streaming/")).toBe("media/streaming");
    });

    it("should strip one leading and one trailing slash together", () => {
      expect(normalizeTag("/media/streaming/")).toBe("media/streaming");
    });

    it("should accept the full legal segment charset", () => {
      expect(normalizeTag("arr-stack/sonarr.v4/db_primary")).toBe("arr-stack/sonarr.v4/db_primary");
      expect(normalizeTag("s3/bucket2")).toBe("s3/bucket2");
    });

    it("should accept a depth-1 tag", () => {
      expect(normalizeTag("infrastructure")).toBe("infrastructure");
    });
  });

  describe("normalizeTag - rejections", () => {
    it("should reject an empty tag", () => {
      expect(() => normalizeTag("")).toThrow(InvalidArgumentError);
      expect(() => normalizeTag("   ")).toThrow(InvalidArgumentError);
      expect(() => normalizeTag("/")).toThrow(InvalidArgumentError);
    });

    it("should reject a doubled interior slash", () => {
      expect(() => normalizeTag("a//b")).toThrow(InvalidArgumentError);
      expect(() => normalizeTag("a//b")).toThrow(/empty path segment/);
    });

    it("should reject a doubled leading slash", () => {
      expect(() => normalizeTag("//a")).toThrow(/empty path segment/);
    });

    it("should reject a doubled trailing slash", () => {
      expect(() => normalizeTag("a//")).toThrow(/empty path segment/);
    });

    it("should reject a segment that does not start alphanumeric", () => {
      expect(() => normalizeTag("-media")).toThrow(InvalidArgumentError);
      expect(() => normalizeTag(".media")).toThrow(InvalidArgumentError);
      expect(() => normalizeTag("_media")).toThrow(InvalidArgumentError);
    });

    it("should reject a segment that does not end alphanumeric", () => {
      expect(() => normalizeTag("media-")).toThrow(InvalidArgumentError);
      expect(() => normalizeTag("media.")).toThrow(InvalidArgumentError);
    });

    it("should reject characters outside the segment charset", () => {
      expect(() => normalizeTag("media streaming")).toThrow(InvalidArgumentError);
      expect(() => normalizeTag("media:streaming")).toThrow(InvalidArgumentError);
      expect(() => normalizeTag("media/*")).toThrow(InvalidArgumentError);
    });

    it("should reject a tag deeper than TAG_MAX_DEPTH", () => {
      const legal = Array.from({ length: TAG_MAX_DEPTH }, (_, i) => `s${String(i)}`).join("/");
      const tooDeep = Array.from({ length: TAG_MAX_DEPTH + 1 }, (_, i) => `s${String(i)}`).join(
        "/",
      );

      expect(normalizeTag(legal)).toBe(legal);
      expect(() => normalizeTag(tooDeep)).toThrow(/maximum depth of 8 segments/);
    });

    it("should reject a segment longer than TAG_MAX_SEGMENT_LENGTH", () => {
      const legal = "a".repeat(TAG_MAX_SEGMENT_LENGTH);
      const tooLong = "a".repeat(TAG_MAX_SEGMENT_LENGTH + 1);

      expect(normalizeTag(legal)).toBe(legal);
      expect(() => normalizeTag(tooLong)).toThrow(/maximum segment length of 40 characters/);
    });

    it("should reject a tag longer than TAG_MAX_LENGTH", () => {
      // 4 x 33-character segments + 3 separators = 135 > 128, while every
      // individual segment and the depth stay inside their own limits.
      const tooLong = Array.from({ length: 4 }, () => "a".repeat(33)).join("/");

      expect(tooLong.length).toBeGreaterThan(TAG_MAX_LENGTH);
      expect(() => normalizeTag(tooLong)).toThrow(/maximum length of 128 characters/);
    });
  });

  describe("normalizeTag - throw sites differ by origin (design 3.2)", () => {
    it("should throw InvalidArgumentError for CLI input by default", () => {
      try {
        normalizeTag("media streaming");
        expect.unreachable("normalizeTag should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidArgumentError);
        const invalid = error as InvalidArgumentError;
        expect(invalid.argument).toBe("--tag");
        expect(invalid.value).toBe("media streaming");
      }
    });

    it("should honour an explicit CLI argument name", () => {
      try {
        normalizeTag("bad tag", { kind: "cli", argument: "--tag" });
        expect.unreachable("normalizeTag should have thrown");
      } catch (error) {
        expect((error as InvalidArgumentError).argument).toBe("--tag");
      }
    });

    it("should throw ConfigValidationError for config input", () => {
      try {
        normalizeTag("Media Streaming", { kind: "config", source: CONFIG_SOURCE });
        expect.unreachable("normalizeTag should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigValidationError);
        const invalid = error as ConfigValidationError;
        expect(invalid.field).toBe("tags.mapping");
        expect(invalid.configSource).toBe(CONFIG_SOURCE);
        expect(invalid.reason).toContain("tag 'Media Streaming' is invalid");
      }
    });

    it("should let the config origin narrow the reported field", () => {
      try {
        normalizeTag("bad tag", {
          kind: "config",
          source: CONFIG_SOURCE,
          field: "tags.mapping.plex",
        });
        expect.unreachable("normalizeTag should have thrown");
      } catch (error) {
        expect((error as ConfigValidationError).field).toBe("tags.mapping.plex");
      }
    });

    it("should not throw ConfigValidationError for a valid config tag", () => {
      expect(normalizeTag("Media/Streaming", { kind: "config", source: CONFIG_SOURCE })).toBe(
        "media/streaming",
      );
    });
  });

  describe("tagAncestors (design 3.3)", () => {
    it("should return every prefix shallowest-first for a depth-3 tag", () => {
      expect(tagAncestors(normalizeTag("a/b/c"))).toEqual(["a", "a/b", "a/b/c"]);
    });

    it("should return exactly the tag itself for a depth-1 tag", () => {
      expect(tagAncestors(normalizeTag("a"))).toEqual(["a"]);
    });

    it("should return both levels for a depth-2 tag", () => {
      expect(tagAncestors(normalizeTag("infrastructure/core"))).toEqual([
        "infrastructure",
        "infrastructure/core",
      ]);
    });

    it("should produce ancestors that are themselves normalized", () => {
      for (const ancestor of tagAncestors(normalizeTag("Infrastructure/Core/Networking"))) {
        expect(normalizeTag(ancestor)).toBe(ancestor);
      }
    });
  });

  describe("compareTags", () => {
    it("should sort a parent before its child", () => {
      expect(compareTags(normalizeTag("a"), normalizeTag("a/b"))).toBeLessThan(0);
      expect(compareTags(normalizeTag("a/b"), normalizeTag("a"))).toBeGreaterThan(0);
    });

    it("should return 0 for identical tags", () => {
      expect(compareTags(normalizeTag("a/b"), normalizeTag("a/b"))).toBe(0);
    });

    it("should order segment-wise rather than by raw string bytes", () => {
      // A plain string compare puts "a-b" between "a" and "a/b" because '-'
      // sorts below '/'. Hierarchical ordering must keep the subtree contiguous.
      const sorted = [
        normalizeTag("a-b"),
        normalizeTag("a/b"),
        normalizeTag("a"),
        normalizeTag("a/a"),
      ].sort(compareTags);

      expect(sorted).toEqual(["a", "a/a", "a/b", "a-b"]);
    });
  });

  describe("isValidTagSegment and shared reasons", () => {
    it("should accept legal segments", () => {
      expect(isValidTagSegment("media")).toBe(true);
      expect(isValidTagSegment("arr-stack")).toBe(true);
      expect(isValidTagSegment("sonarr.v4")).toBe(true);
      expect(isValidTagSegment("db_primary")).toBe(true);
      expect(isValidTagSegment("s3")).toBe(true);
    });

    it("should reject illegal segments", () => {
      expect(isValidTagSegment("")).toBe(false);
      expect(isValidTagSegment("-media")).toBe(false);
      expect(isValidTagSegment("media-")).toBe(false);
      expect(isValidTagSegment("MEDIA")).toBe(false);
      expect(isValidTagSegment("media/core")).toBe(false);
      expect(isValidTagSegment("net*")).toBe(false);
    });

    it("should name the offending segment in the shared reasons", () => {
      expect(invalidSegmentReason("net*")).toContain("'net*'");
      expect(segmentTooLongReason("x".repeat(41))).toContain("40 characters");
    });
  });
});
