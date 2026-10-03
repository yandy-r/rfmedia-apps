import { describe, it, expect } from "vitest";
import type { TagIndex, TagPath } from "../types/tags.js";
import { InvalidArgumentError } from "./errors.js";
import { normalizeTag, tagAncestors } from "./tags/tag-path.js";
import {
  applyTagAxis,
  describeSelector,
  explicitSelectorFlagNames,
  hasExplicitSelector,
  hasServicesSelector,
} from "./selector.js";

/**
 * The design §3.6 fixture, verbatim.
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

/** `whoogle` carries no tags: it must match nothing, including `**`. */
const UNTAGGED = "whoogle";

/**
 * Deliberately NOT alphabetical — every ordering assertion below would pass vacuously
 * against a sorted universe, and P5 promises compose declaration order.
 */
const UNIVERSE: readonly string[] = ["traefik", "homarr", "plex", "sabnzbd", UNTAGGED];

/**
 * Builds the `TagIndex` as a literal rather than through `buildTagIndex`, which is being
 * written concurrently in the same batch. `normalizeTag` mints the branded `TagPath`
 * values — a raw string must never be cast to `TagPath`.
 */
function buildFixtureIndex(
  mapping: Readonly<Record<string, readonly string[]>>,
  universe: readonly string[],
): TagIndex {
  const declared = new Map<string, readonly TagPath[]>();
  const effective = new Map<string, ReadonlySet<TagPath>>();
  const byTag = new Map<TagPath, string[]>();
  const declaredTags = new Set<TagPath>();

  for (const [service, authored] of Object.entries(mapping)) {
    const normalized = authored.map((tag) => normalizeTag(tag));
    const closure = new Set<TagPath>();

    for (const tag of normalized) {
      declaredTags.add(tag);

      for (const ancestor of tagAncestors(tag)) {
        closure.add(ancestor);
      }
    }

    declared.set(service, normalized);
    effective.set(service, closure);

    for (const tag of closure) {
      const services = byTag.get(tag) ?? [];
      services.push(service);
      byTag.set(tag, services);
    }
  }

  return {
    declared,
    effective,
    byTag,
    allTags: [...byTag.keys()].sort(),
    declaredTags,
    unresolvedServices: Object.keys(mapping).filter((service) => !universe.includes(service)),
    source: "/repo/rfapps.config.yaml",
  };
}

const INDEX = buildFixtureIndex(MAPPING, UNIVERSE);

/** The services selected by a `--tag` flag list, in universe order. */
function select(tagFlags: readonly string[]): string[] {
  const axis = applyTagAxis(tagFlags, INDEX, UNIVERSE);

  if (axis.kind !== "present") {
    throw new Error(`expected a present tag axis for ${JSON.stringify(tagFlags)}`);
  }

  return [...axis.matched];
}

describe("hasServicesSelector", () => {
  it("accepts the raw Commander comma-joined string shape", () => {
    expect(hasServicesSelector("plex,traefik")).toBe(true);
    expect(hasServicesSelector("plex")).toBe(true);
  });

  it("accepts the typed string[] shape", () => {
    expect(hasServicesSelector(["plex", "traefik"])).toBe(true);
    expect(hasServicesSelector(["plex"])).toBe(true);
  });

  it("treats undefined as absent", () => {
    expect(hasServicesSelector(undefined)).toBe(false);
  });

  it("treats an empty string as ABSENT (documented behavior change)", () => {
    // cli.ts previously used `!== undefined`, so `--services ""` counted as a target and
    // suppressed the deploy --staged preflight for a selector resolving to nothing.
    expect(hasServicesSelector("")).toBe(false);
    expect(hasServicesSelector("   ")).toBe(false);
  });

  it("treats an empty array as absent", () => {
    expect(hasServicesSelector([])).toBe(false);
  });
});

describe("hasExplicitSelector", () => {
  it("returns false when no targeting flag is present", () => {
    expect(hasExplicitSelector({})).toBe(false);
    expect(hasExplicitSelector({ services: undefined, tag: undefined })).toBe(false);
  });

  it("detects each of the four axes on its own", () => {
    expect(hasExplicitSelector({ service: "plex" })).toBe(true);
    expect(hasExplicitSelector({ services: "plex,traefik" })).toBe(true);
    expect(hasExplicitSelector({ group: "media-stack" })).toBe(true);
    expect(hasExplicitSelector({ tag: ["media/**"] })).toBe(true);
  });

  it("detects the services axis in both shapes", () => {
    expect(hasExplicitSelector({ services: "plex,traefik" })).toBe(true);
    expect(hasExplicitSelector({ services: ["plex", "traefik"] })).toBe(true);
  });

  it("treats an empty services string and an empty services array as absent", () => {
    expect(hasExplicitSelector({ services: "" })).toBe(false);
    expect(hasExplicitSelector({ services: [] })).toBe(false);
  });

  it("treats an empty tag array as absent, so a Commander [] default cannot arm a target", () => {
    expect(hasExplicitSelector({ tag: [] })).toBe(false);
  });

  it("treats a malformed tag value as PRESENT so applyTagAxis can reject it", () => {
    expect(hasExplicitSelector({ tag: [""] })).toBe(true);
  });

  it("stays true when any single axis is present alongside absent ones", () => {
    expect(hasExplicitSelector({ services: "", tag: ["media/**"] })).toBe(true);
    expect(hasExplicitSelector({ group: "media-stack", tag: [] })).toBe(true);
  });
});

describe("explicitSelectorFlagNames", () => {
  it("returns nothing when no axis is present", () => {
    expect(explicitSelectorFlagNames({})).toEqual([]);
    expect(explicitSelectorFlagNames({ services: "", tag: [] })).toEqual([]);
  });

  it("names only the present axes, in declaration order", () => {
    expect(explicitSelectorFlagNames({ group: "arr-stack", tag: ["media/**"] })).toEqual([
      "--group",
      "--tag",
    ]);
  });

  it("names all four axes when all are present", () => {
    expect(
      explicitSelectorFlagNames({
        service: "plex",
        services: ["traefik"],
        group: "arr-stack",
        tag: ["media/**"],
      }),
    ).toEqual(["--service", "--services", "--group", "--tag"]);
  });
});

describe("describeSelector", () => {
  it("renders the present axes with their values, quoting tag patterns", () => {
    expect(describeSelector({ group: "arr-stack", tag: ["media/**"] })).toBe(
      '--group arr-stack, --tag "media/**"',
    );
  });

  it("renders one fragment per --tag occurrence", () => {
    expect(describeSelector({ tag: ["media/**", "!plex"] })).toBe(
      '--tag "media/**", --tag "!plex"',
    );
  });

  it("normalizes the dual-shape services value", () => {
    expect(describeSelector({ services: "plex, traefik" })).toBe("--services plex,traefik");
    expect(describeSelector({ services: ["plex", "traefik"] })).toBe("--services plex,traefik");
  });

  it("returns an empty string when nothing is targeted", () => {
    expect(describeSelector({ services: "", tag: [] })).toBe("");
  });
});

describe("applyTagAxis", () => {
  describe("the absent axis (P1 — backward compatibility is structural)", () => {
    it("returns kind:absent for undefined", () => {
      expect(applyTagAxis(undefined, INDEX, UNIVERSE)).toEqual({ kind: "absent" });
    });

    it("returns kind:absent for an empty array", () => {
      expect(applyTagAxis([], INDEX, UNIVERSE)).toEqual({ kind: "absent" });
    });
  });

  describe("matching", () => {
    it("matches through the ancestor closure, so a bare segment selects the subtree", () => {
      expect(select(["infrastructure"])).toEqual(["traefik", "homarr"]);
    });

    it("treats X and X/** identically", () => {
      expect(select(["infrastructure/**"])).toEqual(select(["infrastructure"]));
    });

    it("matches a service on its second declared tag", () => {
      expect(select(["hardware/gpu"])).toEqual(["plex"]);
    });

    it("is case-insensitive", () => {
      expect(select(["MEDIA/Streaming"])).toEqual(["plex"]);
    });

    it("never matches an untagged service, not even with **", () => {
      expect(select(["**"])).not.toContain(UNTAGGED);
    });

    it("preserves universe order rather than match order (P5)", () => {
      expect(select(["**"])).toEqual(["traefik", "homarr", "plex", "sabnzbd"]);
    });
  });

  describe("composition", () => {
    it("ORs comma-separated patterns within one flag", () => {
      expect(select(["media/**,downloads/**"])).toEqual(["plex", "sabnzbd"]);
    });

    it("ANDs across separate --tag flags", () => {
      expect(select(["infrastructure", "**/networking"])).toEqual(["traefik"]);
      expect(select(["media/**", "hardware/**"])).toEqual(["plex"]);
    });

    it("returns an empty match when the AND of two flags is disjoint", () => {
      expect(select(["media/**", "downloads/**"])).toEqual([]);
    });

    it("excludes negated patterns within a flag", () => {
      expect(select(["**,!media/**"])).toEqual(["traefik", "homarr", "sabnzbd"]);
    });

    it("selects untagged services for a negation-only flag (documented consequence)", () => {
      // E(s) = empty makes every negation vacuously non-excluding, so this is NOT the
      // complement of `--tag "**"`. `--tag "**" --tag "!media/**"` is.
      expect(select(["!media/**"])).toEqual(["traefik", "homarr", "sabnzbd", UNTAGGED]);
      expect(select(["**", "!media/**"])).toEqual(["traefik", "homarr", "sabnzbd"]);
    });
  });

  describe("errors", () => {
    it("never throws on an empty result — that decision belongs to the caller (P2)", () => {
      const axis = applyTagAxis(["typoo/**"], INDEX, UNIVERSE);

      expect(axis.kind).toBe("present");
      expect(axis.kind === "present" ? [...axis.matched] : null).toEqual([]);
    });

    it("throws InvalidArgumentError on a trailing /*", () => {
      expect(() => applyTagAxis(["infrastructure/*"], INDEX, UNIVERSE)).toThrow(
        InvalidArgumentError,
      );
    });

    it("throws InvalidArgumentError on a partial-segment wildcard", () => {
      expect(() => applyTagAxis(["net*"], INDEX, UNIVERSE)).toThrow(InvalidArgumentError);
    });

    it("throws InvalidArgumentError on an empty pattern", () => {
      expect(() => applyTagAxis([""], INDEX, UNIVERSE)).toThrow(InvalidArgumentError);
    });
  });

  it("reports the authored terms so callers can name them in errors", () => {
    const axis = applyTagAxis(["media/**", "!plex"], INDEX, UNIVERSE);

    expect(axis.kind === "present" ? axis.terms.map((term) => term.source) : null).toEqual([
      "media/**",
      "!plex",
    ]);
  });
});
