import { describe, it, expect } from "vitest";
import type { TagPath } from "../../types/tags.js";
import { InvalidArgumentError } from "../errors.js";
import { normalizeTag, tagAncestors } from "./tag-path.js";
import { parseTagPattern, parseTagTerm, serviceMatches, tagMatches } from "./tag-pattern.js";

/**
 * The design 3.6 fixture, verbatim:
 *
 * ```yaml
 * tags:
 *   mapping:
 *     traefik: [infrastructure/core/networking]
 *     homarr:  [infrastructure]
 *     plex:    [media/streaming, hardware/gpu]
 *     sabnzbd: [downloads/usenet]
 * ```
 */
const MAPPING: Readonly<Record<string, readonly string[]>> = {
  traefik: ["infrastructure/core/networking"],
  homarr: ["infrastructure"],
  plex: ["media/streaming", "hardware/gpu"],
  sabnzbd: ["downloads/usenet"],
};

/** A service with no `tags.mapping` entry - it must match nothing, including `**`. */
const UNTAGGED = "whoogle";

const TAGGED_SERVICES = ["traefik", "homarr", "plex", "sabnzbd"] as const;
const UNIVERSE: readonly string[] = [...TAGGED_SERVICES, UNTAGGED];

const EMPTY_EFFECTIVE: ReadonlySet<TagPath> = new Set<TagPath>();

/** E(s) = union over declared tags of tagAncestors(t) - design 3.3. */
const EFFECTIVE: ReadonlyMap<string, ReadonlySet<TagPath>> = new Map(
  Object.entries(MAPPING).map(([service, declared]) => {
    const effective = new Set<TagPath>();

    for (const authored of declared) {
      for (const ancestor of tagAncestors(normalizeTag(authored))) {
        effective.add(ancestor);
      }
    }

    return [service, effective as ReadonlySet<TagPath>] as const;
  }),
);

function effectiveTagsFor(service: string): ReadonlySet<TagPath> {
  return EFFECTIVE.get(service) ?? EMPTY_EFFECTIVE;
}

/** Services matched by a single pattern, in universe order. */
function matchPattern(source: string): string[] {
  const pattern = parseTagPattern(source);

  return UNIVERSE.filter((service) => serviceMatches(pattern, effectiveTagsFor(service)));
}

/**
 * Services selected by one `--tag` flag occurrence (design 3.8):
 * `T_k = INC_k \ EXC_k`, where a negation-only flag has `INC_k = universe`.
 */
function selectTerm(source: string): string[] {
  const term = parseTagTerm(source);

  const included =
    term.include.length === 0
      ? [...UNIVERSE]
      : UNIVERSE.filter((service) =>
          term.include.some((pattern) => serviceMatches(pattern, effectiveTagsFor(service))),
        );

  return included.filter(
    (service) =>
      !term.exclude.some((pattern) => serviceMatches(pattern, effectiveTagsFor(service))),
  );
}

interface PatternRow {
  readonly pattern: string;
  readonly matches: readonly string[];
  readonly notMatches: readonly string[];
  readonly reading: string;
}

/** Every accepting row of the normative design 3.6 table. */
const PATTERN_TABLE: readonly PatternRow[] = [
  {
    pattern: "infrastructure",
    matches: ["traefik", "homarr"],
    notMatches: ["plex", "sabnzbd"],
    reading: "bare segment = the whole subtree, inclusive",
  },
  {
    pattern: "infrastructure/**",
    matches: ["traefik", "homarr"],
    notMatches: ["plex", "sabnzbd"],
    reading: "identical to bare infrastructure (** matches zero segments)",
  },
  {
    pattern: "infrastructure/core",
    matches: ["traefik"],
    notMatches: ["homarr", "plex", "sabnzbd"],
    reading: "exact ancestor match",
  },
  {
    pattern: "infrastructure/core/networking",
    matches: ["traefik"],
    notMatches: ["homarr", "plex", "sabnzbd"],
    reading: "exact declared tag",
  },
  {
    pattern: "infrastructure/core/**",
    matches: ["traefik"],
    notMatches: ["homarr", "plex", "sabnzbd"],
    reading: "subtree below an ancestor",
  },
  {
    pattern: "*/core/**",
    matches: ["traefik"],
    notMatches: ["homarr", "plex", "sabnzbd"],
    reading: "interior single-segment wildcard",
  },
  {
    pattern: "**/networking",
    matches: ["traefik"],
    notMatches: ["homarr", "plex", "sabnzbd"],
    reading: "leaf-anchored, any depth",
  },
  {
    pattern: "*",
    matches: ["traefik", "homarr", "plex", "sabnzbd"],
    notMatches: [UNTAGGED],
    reading: "every service with any depth-1 effective tag",
  },
  {
    pattern: "**",
    matches: ["traefik", "homarr", "plex", "sabnzbd"],
    notMatches: [UNTAGGED],
    reading: "every tagged service",
  },
  {
    pattern: "media",
    matches: ["plex"],
    notMatches: ["traefik", "homarr", "sabnzbd"],
    reading: "bare segment against a depth-2 declared tag",
  },
  {
    pattern: "hardware/gpu",
    matches: ["plex"],
    notMatches: ["traefik", "homarr", "sabnzbd"],
    reading: "a multi-tag service matched on its second tag",
  },
  {
    pattern: "MEDIA/Streaming",
    matches: ["plex"],
    notMatches: ["traefik", "homarr", "sabnzbd"],
    reading: "case-insensitive - normalizes to media/streaming",
  },
  {
    pattern: "typoo/**",
    matches: [],
    notMatches: ["traefik", "homarr", "plex", "sabnzbd"],
    reading: "empty result - the caller raises TagSelectorEmptyError, never returns []",
  },
];

interface TermRow {
  readonly term: string;
  readonly selects: readonly string[];
  readonly excludes: readonly string[];
  readonly reading: string;
}

/** The design 3.6 rows whose semantics live at the `--tag` term level (3.8). */
const TERM_TABLE: readonly TermRow[] = [
  {
    term: "!media/**",
    selects: ["traefik", "homarr", "sabnzbd", UNTAGGED],
    excludes: ["plex"],
    reading: "negation - also selects untagged services (3.8)",
  },
  {
    term: "media/**,hardware/**",
    selects: ["plex"],
    excludes: ["traefik", "homarr", "sabnzbd", UNTAGGED],
    reading: "OR within one --tag flag",
  },
];

describe("tag-pattern", () => {
  describe("design 3.6 pattern table (normative)", () => {
    for (const row of PATTERN_TABLE) {
      it(`'${row.pattern}' matches [${row.matches.join(", ")}] - ${row.reading}`, () => {
        const matched = matchPattern(row.pattern);

        expect(matched).toEqual([...row.matches]);

        for (const service of row.notMatches) {
          expect(matched).not.toContain(service);
        }
      });
    }

    it("rejects 'infrastructure/*' at parse time with the corrective suggestion", () => {
      expect(() => parseTagPattern("infrastructure/*")).toThrow(InvalidArgumentError);

      try {
        parseTagPattern("infrastructure/*");
        expect.unreachable("trailing '/*' must be rejected");
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidArgumentError);
        const invalid = error as InvalidArgumentError;

        expect(invalid.argument).toBe("--tag");
        expect(invalid.value).toBe("infrastructure/*");
        expect(invalid.reason).toContain("trailing '/*' is not supported");
        expect(invalid.reason).toContain("'infrastructure' to select the whole subtree");
        expect(invalid.reason).toContain(
          "'infrastructure/**' for the same thing, written explicitly",
        );
        expect(invalid.validValues).toEqual(["infrastructure", "infrastructure/**"]);
      }
    });
  });

  describe("design 3.6 term table (3.8 semantics)", () => {
    for (const row of TERM_TABLE) {
      it(`'${row.term}' selects [${row.selects.join(", ")}] - ${row.reading}`, () => {
        const selected = selectTerm(row.term);

        expect(selected).toEqual([...row.selects]);

        for (const service of row.excludes) {
          expect(selected).not.toContain(service);
        }
      });
    }

    it("ANDs across separate --tag flags", () => {
      // `--tag "media/**" --tag "hardware/**"` - each flag is a term and the
      // resolver intersects them. Only plex carries both.
      const first = selectTerm("media/**");
      const second = selectTerm("hardware/**");

      expect(first.filter((service) => second.includes(service))).toEqual(["plex"]);
    });

    it("selects untagged services from a negation-only term", () => {
      // E(s) is empty, so every positive pattern is false AND every negation is
      // vacuously non-excluding. `!media/**` is NOT the complement of `**`.
      expect(selectTerm("!media/**")).toContain(UNTAGGED);
      expect(selectTerm("**")).not.toContain(UNTAGGED);
    });

    it("splits a term into include and exclude patterns", () => {
      const term = parseTagTerm("media/**,!media/streaming,hardware/**");

      expect(term.source).toBe("media/**,!media/streaming,hardware/**");
      expect(term.include.map((pattern) => pattern.source)).toEqual(["media/**", "hardware/**"]);
      expect(term.exclude.map((pattern) => pattern.source)).toEqual(["!media/streaming"]);
      expect(term.exclude[0]?.negated).toBe(true);
    });
  });

  describe("derived identity and untagged services", () => {
    it("treats X and X/** as identical (X === X/**)", () => {
      for (const tag of ["infrastructure", "media", "downloads", "hardware"]) {
        expect(matchPattern(tag)).toEqual(matchPattern(`${tag}/**`));
      }
    });

    it("matches nothing for an untagged service, including '**'", () => {
      for (const pattern of ["**", "*", "infrastructure", "media/**", "**/networking"]) {
        expect(serviceMatches(parseTagPattern(pattern), effectiveTagsFor(UNTAGGED))).toBe(false);
      }
    });

    it("returns false from serviceMatches for an empty effective set", () => {
      expect(serviceMatches(parseTagPattern("**"), EMPTY_EFFECTIVE)).toBe(false);
    });
  });

  describe("parseTagPattern", () => {
    it("parses literal, single, and deep elements", () => {
      expect(parseTagPattern("a/*/**").elements).toEqual([
        { kind: "literal", value: "a" },
        { kind: "single" },
        { kind: "deep" },
      ]);
    });

    it("preserves the authored source and lowercases the elements", () => {
      const pattern = parseTagPattern("  MEDIA/Streaming  ");

      expect(pattern.source).toBe("MEDIA/Streaming");
      expect(pattern.negated).toBe(false);
      expect(pattern.elements).toEqual([
        { kind: "literal", value: "media" },
        { kind: "literal", value: "streaming" },
      ]);
    });

    it("records a leading '!' as negation without altering the body", () => {
      const pattern = parseTagPattern("!media/**");

      expect(pattern.negated).toBe(true);
      expect(pattern.source).toBe("!media/**");
      expect(pattern.elements).toEqual([{ kind: "literal", value: "media" }, { kind: "deep" }]);
    });

    it("strips at most one leading and one trailing slash", () => {
      expect(parseTagPattern("/media/").elements).toEqual([{ kind: "literal", value: "media" }]);
      expect(() => parseTagPattern("//media")).toThrow(/empty path element/);
      expect(() => parseTagPattern("media//")).toThrow(/empty path element/);
    });

    it("allows multiple '**' in one pattern", () => {
      const pattern = parseTagPattern("a/**/b/**/c");

      expect(pattern.elements).toHaveLength(5);
      expect(tagMatches(pattern, normalizeTag("a/x/y/b/z/c"))).toBe(true);
      expect(tagMatches(pattern, normalizeTag("a/b/c"))).toBe(true);
      expect(tagMatches(pattern, normalizeTag("a/b/x"))).toBe(false);
      expect(matchPattern("**/core/**")).toEqual(["traefik"]);
    });
  });

  describe("parseTagPattern rejections", () => {
    const partialWildcards = ["net*", "*working", "a**b", "infra?tructure", "media/net*"];

    for (const source of partialWildcards) {
      it(`rejects the partial-segment wildcard '${source}'`, () => {
        expect(() => parseTagPattern(source)).toThrow(InvalidArgumentError);
        expect(() => parseTagPattern(source)).toThrow(/wildcards must occupy a whole path element/);
      });
    }

    it("rejects a trailing '/*' in any position, including after slash stripping", () => {
      expect(() => parseTagPattern("media/*")).toThrow(/trailing '\/\*' is not supported/);
      expect(() => parseTagPattern("media/*/")).toThrow(/trailing '\/\*' is not supported/);
      expect(() => parseTagPattern("!media/*")).toThrow(/trailing '\/\*' is not supported/);
    });

    it("keeps interior single-segment wildcards fully supported", () => {
      expect(() => parseTagPattern("*/core/**")).not.toThrow();
      expect(() => parseTagPattern("media/*/tv")).not.toThrow();
      expect(() => parseTagPattern("*")).not.toThrow();
    });

    it("rejects an empty pattern", () => {
      expect(() => parseTagPattern("")).toThrow(/must not be empty/);
      expect(() => parseTagPattern("   ")).toThrow(/must not be empty/);
      expect(() => parseTagPattern("!")).toThrow(/'!' must be followed by a tag pattern/);
    });

    it("reports a slash-only pattern as empty rather than blaming a '!' the operator never typed", () => {
      for (const source of ["/", "//", " / "]) {
        expect(() => parseTagPattern(source)).toThrow(InvalidArgumentError);
        expect(() => parseTagPattern(source)).toThrow(/tag pattern must not be empty/);
        expect(() => parseTagPattern(source)).not.toThrow(/'!' must be followed by/);
      }
    });

    it("rejects a literal element outside the segment charset", () => {
      expect(() => parseTagPattern("media/-streaming")).toThrow(InvalidArgumentError);
      expect(() => parseTagPattern("media/strea ming")).toThrow(InvalidArgumentError);
    });

    it("rejects a pattern deeper than the maximum depth", () => {
      const tooDeep = Array.from({ length: 9 }, () => "**").join("/");

      expect(() => parseTagPattern(tooDeep)).toThrow(/maximum depth of 8 elements/);
    });
  });

  describe("parseTagTerm rejections", () => {
    it("rejects an empty flag value", () => {
      expect(() => parseTagTerm("")).toThrow(InvalidArgumentError);
      expect(() => parseTagTerm("  ")).toThrow(InvalidArgumentError);
    });

    it("rejects an empty comma-delimited entry", () => {
      expect(() => parseTagTerm("media/**,")).toThrow(/empty entry/);
      expect(() => parseTagTerm(",media/**")).toThrow(/empty entry/);
      expect(() => parseTagTerm("media/**,,hardware/**")).toThrow(/empty entry/);
    });

    it("propagates a malformed pattern from inside a comma list", () => {
      expect(() => parseTagTerm("media/**,infrastructure/*")).toThrow(
        /trailing '\/\*' is not supported/,
      );
    });
  });

  describe("tagMatches (design 3.5 anchored DP)", () => {
    it("anchors the pattern at both ends", () => {
      expect(tagMatches(parseTagPattern("media"), normalizeTag("media"))).toBe(true);
      expect(tagMatches(parseTagPattern("media"), normalizeTag("media/streaming"))).toBe(false);
      expect(tagMatches(parseTagPattern("streaming"), normalizeTag("media/streaming"))).toBe(false);
    });

    it("never lets '*' cross a slash", () => {
      expect(tagMatches(parseTagPattern("*"), normalizeTag("media"))).toBe(true);
      expect(tagMatches(parseTagPattern("*"), normalizeTag("media/streaming"))).toBe(false);
      expect(tagMatches(parseTagPattern("*/streaming"), normalizeTag("media/streaming"))).toBe(
        true,
      );
    });

    it("lets '**' match zero or more segments", () => {
      expect(tagMatches(parseTagPattern("media/**"), normalizeTag("media"))).toBe(true);
      expect(tagMatches(parseTagPattern("media/**"), normalizeTag("media/streaming"))).toBe(true);
      expect(tagMatches(parseTagPattern("**"), normalizeTag("a/b/c/d/e/f/g/h"))).toBe(true);
    });

    it("ignores negation - the term arithmetic owns exclusion", () => {
      expect(tagMatches(parseTagPattern("!media"), normalizeTag("media"))).toBe(true);
    });

    it("compares literal segments case-insensitively via normalization", () => {
      expect(tagMatches(parseTagPattern("MEDIA/Streaming"), normalizeTag("media/streaming"))).toBe(
        true,
      );
    });
  });
});
