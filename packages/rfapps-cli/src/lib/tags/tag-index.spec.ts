import { describe, it, expect, vi, beforeEach } from "vitest";

import type { RfappsConfig } from "../../types/config.js";
import type { TagPath } from "../../types/tags.js";
import { ConfigValidationError } from "../errors.js";
import { findClosestMatch } from "../fuzzy-match.js";
import {
  assertTagList,
  assertTagMapping,
  buildTagIndex,
  findClosestTag,
  getTagIndex,
} from "./tag-index.js";
import { normalizeTag } from "./tag-path.js";

const { listConfigLayerPathsMock, readFileMock } = vi.hoisted(() => ({
  listConfigLayerPathsMock: vi.fn<(cwd?: string) => Promise<string[]>>(),
  readFileMock: vi.fn<(path: string, encoding: string) => Promise<string>>(),
}));

// `../config.js` is mocked rather than exercised so the spec neither touches the real config
// layers on the developer's machine nor loads the SQLite-backed module graph behind it.
vi.mock("../config.js", () => ({ listConfigLayerPaths: listConfigLayerPathsMock }));
vi.mock("node:fs/promises", () => ({ readFile: readFileMock }));

/** The design §3.6 fixture, verbatim. */
const FIXTURE_MAPPING: Readonly<Record<string, readonly string[]>> = {
  traefik: ["infrastructure/core/networking"],
  homarr: ["infrastructure"],
  plex: ["media/streaming", "hardware/gpu"],
  sabnzbd: ["downloads/usenet"],
};

/** Compose declaration order, including one deliberately untagged service. */
const UNIVERSE = ["traefik", "homarr", "plex", "sabnzbd", "authentik-server"];

const SOURCE = "/repo/rfapps.config.yaml";
const LOCAL_LAYER = "/repo/.rfapps.yaml";

/** Mints a `TagPath` through the only legal minting site, for map lookups. */
function tag(value: string): TagPath {
  return normalizeTag(value);
}

function buildFixture(
  overrides: Readonly<Record<string, readonly string[]>> = {},
  universe: readonly string[] = UNIVERSE,
): ReturnType<typeof buildTagIndex> {
  return buildTagIndex({
    mapping: { ...FIXTURE_MAPPING, ...overrides },
    universe,
    source: SOURCE,
  });
}

/**
 * Types an ill-shaped `tags.mapping` the way YAML actually delivers it.
 *
 * `YAML.parse` is cast straight to `PartialRfappsConfig` by `config.ts`, so the declared
 * `readonly string[]` is a claim about the file, not a proof. These fixtures reproduce what
 * the parser really hands `buildTagIndex` for a scalar or mixed-type entry.
 */
function looseMapping(
  mapping: Readonly<Record<string, unknown>>,
): Readonly<Record<string, readonly string[]>> {
  return mapping as Readonly<Record<string, readonly string[]>>;
}

/**
 * The same escape hatch for the mapping **container**, which YAML can deliver as any scalar.
 *
 * `looseMapping` cannot express these: a number or a bare string is not a
 * `Record<string, unknown>` either.
 */
function looseContainer(mapping: unknown): Readonly<Record<string, readonly string[]>> {
  return mapping as Readonly<Record<string, readonly string[]>>;
}

/** Runs `buildTagIndex` over an ill-shaped container and returns whatever it threw. */
function captureContainerError(mapping: unknown): unknown {
  try {
    buildTagIndex({
      mapping: looseContainer(mapping),
      universe: ["plex", "traefik"],
      source: SOURCE,
    });
  } catch (error) {
    return error;
  }

  return undefined;
}

function makeConfig(mapping: Readonly<Record<string, readonly string[]>>): RfappsConfig {
  return { tags: { mapping } } as unknown as RfappsConfig;
}

/** Points `listConfigLayerPaths` at `layers` and serves `files` from the mocked `readFile`. */
function stubConfigLayers(
  layers: readonly string[],
  files: Readonly<Record<string, string>>,
): void {
  listConfigLayerPathsMock.mockResolvedValue([...layers]);
  readFileMock.mockImplementation(async (path: string) => {
    const content = files[path];

    if (content === undefined) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }

    return content;
  });
}

const TAGS_YAML = ["tags:", "  mapping:", "    plex:", "      - media/streaming", ""].join("\n");

describe("tag-index", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("buildTagIndex - ancestor closure (design 3.3)", () => {
    it("should close every declared tag over its ancestors", () => {
      const { index } = buildFixture();

      expect([...(index.effective.get("traefik") ?? [])]).toEqual([
        "infrastructure",
        "infrastructure/core",
        "infrastructure/core/networking",
      ]);
    });

    it("should union the closures of a multi-tag service", () => {
      const { index } = buildFixture();

      expect([...(index.effective.get("plex") ?? [])].sort()).toEqual([
        "hardware",
        "hardware/gpu",
        "media",
        "media/streaming",
      ]);
    });

    it("should leave a depth-1 tag as its own only ancestor", () => {
      const { index } = buildFixture();

      expect([...(index.effective.get("homarr") ?? [])]).toEqual(["infrastructure"]);
    });

    it("should keep declared free of derived ancestors", () => {
      const { index } = buildFixture();

      expect(index.declared.get("traefik")).toEqual(["infrastructure/core/networking"]);
      expect(index.declared.get("plex")).toEqual(["media/streaming", "hardware/gpu"]);
    });

    it("should omit a compose service that declares no tags", () => {
      const { index } = buildFixture();

      expect(index.declared.has("authentik-server")).toBe(false);
      expect(index.effective.has("authentik-server")).toBe(false);
    });
  });

  describe("buildTagIndex - byTag inverse", () => {
    it("should invert effective, not declared", () => {
      const { index } = buildFixture();

      // homarr declared `infrastructure`; traefik only carries it by closure.
      expect(index.byTag.get(tag("infrastructure"))).toEqual(["traefik", "homarr"]);
      expect(index.byTag.get(tag("infrastructure/core"))).toEqual(["traefik"]);
      expect(index.byTag.get(tag("media"))).toEqual(["plex"]);
      expect(index.byTag.get(tag("hardware/gpu"))).toEqual(["plex"]);
    });

    it("should list carriers in compose declaration order", () => {
      const { index } = buildTagIndex({
        mapping: { plex: ["media"], homarr: ["media"], traefik: ["media"] },
        universe: UNIVERSE,
        source: SOURCE,
      });

      expect(index.byTag.get(tag("media"))).toEqual(["traefik", "homarr", "plex"]);
    });

    it("should have no entry for a tag nobody carries", () => {
      const { index } = buildFixture();

      expect(index.byTag.has(tag("media/automation"))).toBe(false);
    });
  });

  describe("buildTagIndex - allTags and declaredTags", () => {
    it("should list every effective tag in hierarchical order", () => {
      const { index } = buildFixture();

      expect([...index.allTags]).toEqual([
        "downloads",
        "downloads/usenet",
        "hardware",
        "hardware/gpu",
        "infrastructure",
        "infrastructure/core",
        "infrastructure/core/networking",
        "media",
        "media/streaming",
      ]);
    });

    it("should order a parent before its children even against sibling punctuation", () => {
      const { index } = buildTagIndex({
        mapping: { plex: ["media/streaming"], homarr: ["media-old"] },
        universe: ["homarr", "plex"],
        source: SOURCE,
      });

      expect([...index.allTags]).toEqual(["media", "media/streaming", "media-old"]);
    });

    it("should hold only authored tags in declaredTags", () => {
      const { index } = buildFixture();

      expect([...index.declaredTags].sort()).toEqual([
        "downloads/usenet",
        "hardware/gpu",
        "infrastructure",
        "infrastructure/core/networking",
        "media/streaming",
      ]);
      expect(index.declaredTags.has(tag("infrastructure/core"))).toBe(false);
      expect(index.declaredTags.has(tag("media"))).toBe(false);
    });

    it("should deduplicate declared tags that normalize to the same path", () => {
      const { index } = buildTagIndex({
        mapping: { plex: ["media/streaming", "MEDIA/Streaming/"] },
        universe: ["plex"],
        source: SOURCE,
      });

      expect(index.declared.get("plex")).toEqual(["media/streaming"]);
      expect(index.byTag.get(tag("media/streaming"))).toEqual(["plex"]);
    });
  });

  describe("buildTagIndex - unresolvedServices (post-condition P4)", () => {
    it("should record a mapping entry absent from the compose universe", () => {
      const { index } = buildFixture({ "plex-old": ["media/streaming"] });

      expect(index.unresolvedServices).toEqual(["plex-old"]);
    });

    it("should be empty when every mapping entry exists in compose", () => {
      const { index } = buildFixture();

      expect(index.unresolvedServices).toEqual([]);
    });

    it("should still index the stale service so the empty-selector error can name it", () => {
      const { index } = buildFixture({ "plex-old": ["media/streaming"] });

      expect(index.declared.get("plex-old")).toEqual(["media/streaming"]);
      expect(index.byTag.get(tag("media/streaming"))).toEqual(["plex", "plex-old"]);
    });
  });

  describe("buildTagIndex - populated surface", () => {
    it("should populate all seven TagIndex fields", () => {
      const { index } = buildFixture({ "plex-old": ["media/streaming"] });

      expect(index.declared.size).toBe(5);
      expect(index.effective.size).toBe(5);
      expect(index.byTag.size).toBe(9);
      expect(index.allTags).toHaveLength(9);
      expect(index.declaredTags.size).toBe(5);
      expect(index.unresolvedServices).toEqual(["plex-old"]);
      expect(index.source).toBe(SOURCE);
    });

    it("should build an empty index from an empty mapping", () => {
      const { index, warnings } = buildTagIndex({
        mapping: {},
        universe: UNIVERSE,
        source: SOURCE,
      });

      expect(index.declared.size).toBe(0);
      expect(index.effective.size).toBe(0);
      expect(index.byTag.size).toBe(0);
      expect(index.allTags).toEqual([]);
      expect(index.declaredTags.size).toBe(0);
      expect(index.unresolvedServices).toEqual([]);
      expect(index.source).toBe(SOURCE);
      expect(warnings).toEqual([]);
    });
  });

  describe("buildTagIndex - normalization warnings (design 3.2)", () => {
    it("should report a case-folded tag without rejecting it", () => {
      const { index, warnings } = buildTagIndex({
        mapping: { plex: ["Media/Streaming"] },
        universe: ["plex"],
        source: SOURCE,
      });

      expect(warnings).toEqual([
        {
          service: "plex",
          authored: "Media/Streaming",
          normalized: "media/streaming",
          message: "Tag 'Media/Streaming' for service 'plex' was normalized to 'media/streaming'",
        },
      ]);
      expect(index.declared.get("plex")).toEqual(["media/streaming"]);
    });

    it("should report a stripped trailing slash", () => {
      const { warnings } = buildTagIndex({
        mapping: { plex: ["media/streaming/"] },
        universe: ["plex"],
        source: SOURCE,
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.normalized).toBe("media/streaming");
    });

    it("should not warn for an already-canonical mapping", () => {
      const { warnings } = buildFixture();

      expect(warnings).toEqual([]);
    });

    it("should not warn when only surrounding whitespace was trimmed", () => {
      const { warnings } = buildTagIndex({
        mapping: { plex: ["  media/streaming  "] },
        universe: ["plex"],
        source: SOURCE,
      });

      expect(warnings).toEqual([]);
    });
  });

  describe("buildTagIndex - fail-fast on malformed config", () => {
    it("should throw ConfigValidationError naming the config source", () => {
      let captured: unknown;

      try {
        buildTagIndex({
          mapping: { plex: ["media//streaming"] },
          universe: ["plex"],
          source: SOURCE,
        });
      } catch (error) {
        captured = error;
      }

      expect(captured).toBeInstanceOf(ConfigValidationError);
      const configError = captured as ConfigValidationError;
      expect(configError.field).toBe("tags.mapping");
      expect(configError.configSource).toBe(SOURCE);
    });

    it("should reject a malformed tag on a service absent from compose too", () => {
      expect(() =>
        buildTagIndex({
          mapping: { "plex-old": ["Media Streaming"] },
          universe: [],
          source: SOURCE,
        }),
      ).toThrow(ConfigValidationError);
    });
  });

  describe("buildTagIndex - mapping value shape (design 3.2)", () => {
    // A YAML scalar is iterable, so an unguarded `for…of` would shred `media` into the
    // one-character tags a/d/e/i/m and silently drop plex from every `--tag media` selection.
    it("should reject a scalar mapping value rather than iterating its characters", () => {
      let captured: unknown;

      try {
        buildTagIndex({
          mapping: looseMapping({ plex: "media" }),
          universe: ["plex"],
          source: SOURCE,
        });
      } catch (error) {
        captured = error;
      }

      expect(captured).toBeInstanceOf(ConfigValidationError);
      const configError = captured as ConfigValidationError;
      expect(configError.field).toBe("tags.mapping");
      expect(configError.configSource).toBe(SOURCE);
      expect(configError.reason).toContain("plex");
      expect(configError.reason).toContain("list of tag paths");
    });

    it("should reject a multi-segment scalar without blaming an empty tag", () => {
      let captured: unknown;

      try {
        buildTagIndex({
          mapping: looseMapping({ plex: "media/streaming" }),
          universe: ["plex"],
          source: SOURCE,
        });
      } catch (error) {
        captured = error;
      }

      expect(captured).toBeInstanceOf(ConfigValidationError);
      expect((captured as ConfigValidationError).reason).not.toContain("must not be empty");
      expect((captured as ConfigValidationError).reason).toContain("list of tag paths");
    });

    it("should reject a non-string entry instead of crashing on input.trim", () => {
      let captured: unknown;

      try {
        buildTagIndex({
          mapping: looseMapping({ plex: ["monitoring", 2024] }),
          universe: ["plex"],
          source: SOURCE,
        });
      } catch (error) {
        captured = error;
      }

      expect(captured).toBeInstanceOf(ConfigValidationError);
      const configError = captured as ConfigValidationError;
      expect(configError.field).toBe("tags.mapping");
      expect(configError.configSource).toBe(SOURCE);
      expect(configError.reason).toContain("number");
      expect(configError.reason).toContain("quote");
    });

    it("should reject a mapping value that is a bare object", () => {
      expect(() =>
        buildTagIndex({
          mapping: looseMapping({ plex: { media: true } }),
          universe: ["plex"],
          source: SOURCE,
        }),
      ).toThrow(ConfigValidationError);
    });

    // `plex:` with nothing after it — the YAML an operator writes when the list is forgotten or
    // its only item is commented out — parses to `null`, not to `[]`. Coalescing it away before
    // the shape check made it indistinguishable from "no tags": `rfapps validate` passed clean,
    // `--tag media` silently dropped plex, and `--tag '!media'` silently pulled it into a delete.
    it("should reject a null mapping value rather than treating it as no tags", () => {
      let captured: unknown;

      try {
        buildTagIndex({
          mapping: looseMapping({ plex: null }),
          universe: ["plex"],
          source: SOURCE,
        });
      } catch (error) {
        captured = error;
      }

      expect(captured).toBeInstanceOf(ConfigValidationError);
      const configError = captured as ConfigValidationError;
      expect(configError.field).toBe("tags.mapping");
      expect(configError.configSource).toBe(SOURCE);
      expect(configError.reason).toContain("plex");
      expect(configError.reason).toContain("list of tag paths");
      expect(configError.reason).toContain("null");
    });

    // The guard must not overreach: an explicitly empty list is legal config meaning "no tags".
    it("should accept an explicitly empty list as no tags", () => {
      const { index, warnings } = buildTagIndex({
        mapping: looseMapping({ plex: [] }),
        universe: ["plex"],
        source: SOURCE,
      });

      expect(warnings).toEqual([]);
      expect(index.declared.get("plex")).toEqual([]);
      expect(index.effective.get("plex")?.size).toBe(0);
      expect(index.allTags).toEqual([]);
    });

    it("should still reject a shape carried only by a service absent from compose", () => {
      expect(() =>
        buildTagIndex({
          mapping: looseMapping({ "plex-old": "media" }),
          universe: [],
          source: SOURCE,
        }),
      ).toThrow(ConfigValidationError);
    });
  });

  describe("buildTagIndex - mapping container shape (design 3.2)", () => {
    // The container is read with `Object.keys` / `Object.entries`, which return `[]` rather than
    // throwing. Unguarded, every shape below produced an empty index with **no diagnostic on any
    // surface**: `tag list` said "no tags are defined" for a file containing a `mapping:` key,
    // `validate` reported success with zero warnings, and `delete --tag '!media'` matched every
    // service in the project and offered to delete it.
    // The class-instance rows matter as much as the scalars: an explicit YAML type tag
    // (`!!set`, `!!omap`, `!!timestamp`, `!!binary`) parses to a Set / Map / Date / Buffer,
    // which a `typeof value === "object"` check admits. Those reach the same silent
    // whole-project selection, so the container guard narrows on the prototype instead.
    it.each([
      ["a number", 42, "number"],
      ["a boolean", true, "boolean"],
      ["an empty string", "", "string"],
      ["a Set (!!set)", new Set(["plex"]), "Set"],
      ["a Map (!!omap)", new Map([["plex", ["media"]]]), "Map"],
      ["a Date (!!timestamp)", new Date(0), "Date"],
    ])(
      "should reject %s container instead of silently emptying the taxonomy",
      (_label, value, shape) => {
        const captured = captureContainerError(value);

        expect(captured).toBeInstanceOf(ConfigValidationError);
        const configError = captured as ConfigValidationError;
        expect(configError.field).toBe("tags.mapping");
        expect(configError.configSource).toBe(SOURCE);
        expect(configError.reason).toContain("tags.mapping must be a mapping");
        expect(configError.reason).toContain(`got ${shape}`);
      },
    );

    // A string and a list *did* trip the per-value guard, but only by accident: their indices
    // become "service" keys, so the operator was told `entry for '0' must be a list of tag paths`
    // and sent looking for a service named `0` that does not exist anywhere.
    it.each([
      ["a non-empty string", "media", "string"],
      ["a list", ["plex", "sonarr"], "list"],
      // A Buffer (`!!binary`) has index-like keys, so an unguarded container reached the
      // per-value guard and reported `entry for '0'` for a service that does not exist.
      ["a Buffer (!!binary)", Buffer.from("hi"), "Buffer"],
    ])("should blame the container, not a phantom service, for %s", (_label, value, shape) => {
      const captured = captureContainerError(value);

      expect(captured).toBeInstanceOf(ConfigValidationError);
      const configError = captured as ConfigValidationError;
      expect(configError.reason).toContain("tags.mapping must be a mapping");
      expect(configError.reason).toContain(`got ${shape}`);
      expect(configError.reason).not.toContain("entry for '0'");
    });

    // The guard must not overreach: these three are the legal ways to say "no taxonomy yet".
    it.each([
      ["null", null],
      ["undefined", undefined],
      ["an empty object", {}],
    ])("should keep %s meaning no taxonomy rather than an error", (_label, value) => {
      const { index, warnings } = buildTagIndex({
        mapping: looseContainer(value),
        universe: UNIVERSE,
        source: SOURCE,
      });

      expect(warnings).toEqual([]);
      expect(index.allTags).toEqual([]);
      expect(index.declared.size).toBe(0);
      expect(index.unresolvedServices).toEqual([]);
      expect(index.source).toBe(SOURCE);
    });
  });

  // The guards are exported so every surface shares one definition of a legal `tags.mapping`.
  // `actions/completion.ts` must not throw (it runs from shell startup), so it needs to be able
  // to call them standalone and catch — not to keep a private near-verbatim copy, which is
  // exactly how the container check came to exist on one surface and not the other.
  describe("exported guards - one definition of a legal tags.mapping", () => {
    it("should expose assertTagMapping as a standalone, catchable check", () => {
      expect(assertTagMapping({ plex: ["media"] }, SOURCE)).toEqual({ plex: ["media"] });
      expect(assertTagMapping(null, SOURCE)).toEqual({});
      expect(assertTagMapping(undefined, SOURCE)).toEqual({});

      let captured: unknown;

      try {
        assertTagMapping(42, SOURCE);
      } catch (error) {
        captured = error;
      }

      expect(captured).toBeInstanceOf(ConfigValidationError);
      expect((captured as ConfigValidationError).configSource).toBe(SOURCE);
      // The caught value must carry a renderable `message`, not just structured fields — a
      // non-throwing consumer degrades by printing `error.message`.
      expect((captured as Error).message).toContain("tags.mapping must be a mapping");
    });

    it("should expose assertTagList as a standalone, catchable check", () => {
      expect(assertTagList(["media/streaming"], "plex", SOURCE)).toEqual(["media/streaming"]);

      expect(() => assertTagList("media", "plex", SOURCE)).toThrow(ConfigValidationError);
      expect(() => assertTagList(["media", 2024], "plex", SOURCE)).toThrow(ConfigValidationError);
    });
  });

  describe("findClosestTag re-export (design 3.9)", () => {
    it("should suggest a deep tag where the shared fuzzy matcher finds nothing", () => {
      const { index } = buildFixture();
      const knownTags = [...index.allTags];

      expect(findClosestMatch("networking", knownTags)).toBeUndefined();
      expect(findClosestTag("networking", index.allTags)).toBe("infrastructure/core/networking");
    });

    it("should return undefined when nothing is close enough", () => {
      const { index } = buildFixture();

      expect(findClosestTag("zzzzzzzz", index.allTags)).toBeUndefined();
    });
  });

  describe("getTagIndex - memoization", () => {
    it("should build the index once per config and compose path", async () => {
      stubConfigLayers([SOURCE], { [SOURCE]: TAGS_YAML });
      const config = makeConfig({ plex: ["media/streaming"] });

      const first = await getTagIndex(config, "/repo/compose.yml", ["plex"]);
      const second = await getTagIndex(config, "/repo/compose.yml", ["plex"]);

      expect(second).toBe(first);
      expect(listConfigLayerPathsMock).toHaveBeenCalledTimes(1);
      expect(readFileMock).toHaveBeenCalledTimes(1);
    });

    it("should rebuild for a different compose path", async () => {
      stubConfigLayers([SOURCE], { [SOURCE]: TAGS_YAML });
      const config = makeConfig({ plex: ["media/streaming"] });

      const first = await getTagIndex(config, "/repo/compose.yml", ["plex"]);
      const second = await getTagIndex(config, "/repo/other.yml", ["plex"]);

      expect(second).not.toBe(first);
      expect(listConfigLayerPathsMock).toHaveBeenCalledTimes(2);
    });

    it("should rebuild for a different config identity", async () => {
      stubConfigLayers([SOURCE], { [SOURCE]: TAGS_YAML });

      await getTagIndex(makeConfig({ plex: ["media/streaming"] }), "/repo/compose.yml", ["plex"]);
      await getTagIndex(makeConfig({ plex: ["media/streaming"] }), "/repo/compose.yml", ["plex"]);

      expect(listConfigLayerPathsMock).toHaveBeenCalledTimes(2);
    });

    it("should share one build between concurrent callers", async () => {
      stubConfigLayers([SOURCE], { [SOURCE]: TAGS_YAML });
      const config = makeConfig({ plex: ["media/streaming"] });

      const [first, second] = await Promise.all([
        getTagIndex(config, "/repo/compose.yml", ["plex"]),
        getTagIndex(config, "/repo/compose.yml", ["plex"]),
      ]);

      expect(second).toBe(first);
      expect(listConfigLayerPathsMock).toHaveBeenCalledTimes(1);
    });

    it("should project config.tags.mapping onto the supplied universe", async () => {
      stubConfigLayers([SOURCE], { [SOURCE]: TAGS_YAML });
      const config = makeConfig({ plex: ["media/streaming"], "plex-old": ["media/streaming"] });

      const index = await getTagIndex(config, "/repo/compose.yml", ["plex", "homarr"]);

      expect(index.unresolvedServices).toEqual(["plex-old"]);
      expect([...index.allTags]).toEqual(["media", "media/streaming"]);
    });

    it("should treat an absent tags section as an empty mapping", async () => {
      stubConfigLayers([SOURCE], { [SOURCE]: "groups: {}\n" });
      const config = {} as unknown as RfappsConfig;

      const index = await getTagIndex(config, "/repo/compose.yml", ["plex"]);

      expect(index.allTags).toEqual([]);
      expect(index.declared.size).toBe(0);
    });
  });

  describe("getTagIndex - source attribution (design 5.4)", () => {
    it("should attribute the highest-precedence layer that supplies a mapping", async () => {
      stubConfigLayers([LOCAL_LAYER, SOURCE], {
        [LOCAL_LAYER]: TAGS_YAML,
        [SOURCE]: TAGS_YAML,
      });

      const index = await getTagIndex(makeConfig({}), "/repo/compose.yml", []);

      expect(index.source).toBe(LOCAL_LAYER);
      expect(readFileMock).toHaveBeenCalledTimes(1);
    });

    it("should skip a higher layer whose tags block supplies no mapping", async () => {
      stubConfigLayers([LOCAL_LAYER, SOURCE], {
        [LOCAL_LAYER]: "tags:\n",
        [SOURCE]: TAGS_YAML,
      });

      const index = await getTagIndex(makeConfig({}), "/repo/compose.yml", []);

      expect(index.source).toBe(SOURCE);
    });

    it("should fall back to the lowest-precedence layer when none declares tags", async () => {
      stubConfigLayers([LOCAL_LAYER, SOURCE], {
        [LOCAL_LAYER]: "groups: {}\n",
        [SOURCE]: "groups: {}\n",
      });

      const index = await getTagIndex(makeConfig({}), "/repo/compose.yml", []);

      expect(index.source).toBe(SOURCE);
    });

    it("should skip a layer that cannot be read or parsed", async () => {
      stubConfigLayers([LOCAL_LAYER, SOURCE], { [SOURCE]: TAGS_YAML });

      const index = await getTagIndex(makeConfig({}), "/repo/compose.yml", []);

      expect(index.source).toBe(SOURCE);
    });

    it("should report an empty source when no config layer exists on disk", async () => {
      stubConfigLayers([], {});

      const index = await getTagIndex(makeConfig({}), "/repo/compose.yml", []);

      expect(index.source).toBe("");
    });
  });
});
