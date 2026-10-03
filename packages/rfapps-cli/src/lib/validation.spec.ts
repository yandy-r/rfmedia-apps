/**
 * Validation cache behavior tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Stats } from "node:fs";

const mockFs = vi.hoisted(() => ({
  readFile: vi.fn(),
  stat: vi.fn(),
}));

const mockLogger = vi.hoisted(() => ({
  logDebug: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: mockFs.readFile,
  stat: mockFs.stat,
}));

vi.mock("@rfmedia/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rfmedia/common")>();
  return {
    ...actual,
    ...mockLogger,
  };
});

// Config layer discovery is stubbed so the tag-ownership tests never read the developer's own
// `.rfapps.yaml`. It defaults to "no layers", which is what the pre-existing suite already
// effectively saw (real discovery fails against the mocked `node:fs/promises`).
const mockConfig = vi.hoisted(() => ({
  listConfigLayerPaths: vi.fn<(cwd?: string) => Promise<string[]>>().mockResolvedValue([]),
}));

vi.mock("./config.js", () => ({
  listConfigLayerPaths: mockConfig.listConfigLayerPaths,
}));

import { ServiceNotFoundError, ComposeFileParseError } from "./errors.js";
import {
  clearValidationCache,
  findOrphanedServices,
  findUndefinedServices,
  formatValidationWarnings,
  hasErrors,
  parseComposeFile,
  validateConfigAgainstCompose,
  validateGroupReferences,
  validateProfileMappings,
  validateServiceNames,
  validateSidecarReferences,
  validateTagLayerOwnership,
  validateTagReferences,
} from "./validation.js";
import type { RfappsConfig } from "../types/index.js";

const composeContent = `services:
  web:
    image: nginx
  db:
    image: postgres
`;

function createStat(mtimeMs: number, size: number): Stats {
  return { mtimeMs, size } as Stats;
}

describe("validation compose cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearValidationCache();
  });

  it("reuses cached services when compose file is unchanged", async () => {
    mockFs.readFile.mockResolvedValue(composeContent);
    mockFs.stat.mockResolvedValue(createStat(1000, 200));

    const first = await parseComposeFile("/path/to/compose.yml");
    const second = await parseComposeFile("/path/to/compose.yml");

    expect(first).toEqual(["web", "db"]);
    expect(second).toEqual(["web", "db"]);
    expect(first).not.toBe(second);
    expect(mockFs.readFile).toHaveBeenCalledTimes(1);
    expect(mockFs.stat).toHaveBeenCalledTimes(2);
  });

  it("re-reads compose file when metadata changes", async () => {
    mockFs.readFile.mockResolvedValue(composeContent);
    mockFs.stat
      .mockResolvedValueOnce(createStat(1000, 200)) // cache update
      .mockResolvedValueOnce(createStat(2000, 200)) // cache validation (changed)
      .mockResolvedValueOnce(createStat(2000, 200)); // cache update after re-read

    await parseComposeFile("/path/to/compose.yml");
    await parseComposeFile("/path/to/compose.yml");

    expect(mockFs.readFile).toHaveBeenCalledTimes(2);
  });

  it("clearValidationCache forces a re-read", async () => {
    mockFs.readFile.mockResolvedValue(composeContent);
    mockFs.stat.mockResolvedValue(createStat(1000, 200));

    await parseComposeFile("/path/to/compose.yml");
    await parseComposeFile("/path/to/compose.yml");

    clearValidationCache();

    await parseComposeFile("/path/to/compose.yml");

    expect(mockFs.readFile).toHaveBeenCalledTimes(2);
  });

  it("returns an empty service list when compose has no services", async () => {
    mockFs.readFile.mockResolvedValue("name: no-services\n");
    mockFs.stat.mockResolvedValue(createStat(1000, 200));

    await expect(parseComposeFile("/path/to/compose.yml")).resolves.toEqual([]);
  });

  it("wraps compose parse failures in ComposeFileParseError", async () => {
    mockFs.readFile.mockRejectedValue(new Error("permission denied"));

    await expect(parseComposeFile("/path/to/compose.yml")).rejects.toBeInstanceOf(
      ComposeFileParseError,
    );
  });

  it("validates service names and includes fuzzy suggestions for missing services", async () => {
    mockFs.readFile.mockResolvedValue(composeContent);
    mockFs.stat.mockResolvedValue(createStat(1000, 200));

    await expect(validateServiceNames(["web"], "/path/to/compose.yml")).resolves.toBeUndefined();
    await expect(validateServiceNames(["weeb"], "/path/to/compose.yml")).rejects.toBeInstanceOf(
      ServiceNotFoundError,
    );
  });

  it("validates sidecar, group, and profile references", () => {
    expect(
      validateSidecarReferences({ plex: "plex-ts", missing: "missing-ts" }, ["plex", "plex-ts"]),
    ).toEqual([
      {
        message: "Sidecar mapping references non-existent main service: missing",
        context: "missing",
        severity: "warning",
      },
      {
        message: "Sidecar mapping references non-existent sidecar: missing-ts",
        context: "missing-ts",
        severity: "warning",
      },
    ]);

    expect(
      validateGroupReferences({ media: ["plex", "missing"], bad: "nope" as never }, ["plex"]),
    ).toEqual([
      {
        message: "Group 'media' references non-existent service: missing",
        context: "media",
        severity: "warning",
      },
      {
        message: "Group 'bad' is not an array of services",
        context: "bad",
        severity: "error",
      },
    ]);

    expect(validateProfileMappings({ plex: "media" as never }, ["all"])).toEqual([
      {
        message: "Service 'plex' has invalid profile: media",
        context: "plex",
        severity: "error",
      },
    ]);
  });

  it("finds undefined and orphaned services and formats warnings", () => {
    const undefinedWarnings = findUndefinedServices(["plex", "sonarr"], { plex: "media" });
    const orphanedWarnings = findOrphanedServices(["plex"], { plex: "media", ghost: "all" });

    expect(undefinedWarnings).toEqual([
      {
        message: "Service 'sonarr' found in compose.yml but not defined in config profiles",
        context: "sonarr",
        severity: "warning",
      },
    ]);
    expect(orphanedWarnings).toEqual([
      {
        message: "Service 'ghost' defined in config but not found in compose.yml",
        context: "ghost",
        severity: "warning",
      },
    ]);
    expect(formatValidationWarnings([...undefinedWarnings, ...orphanedWarnings])).toEqual([
      "⚠️ Service 'sonarr' found in compose.yml but not defined in config profiles [sonarr]",
      "⚠️ Service 'ghost' defined in config but not found in compose.yml [ghost]",
    ]);
    expect(hasErrors(undefinedWarnings)).toBe(false);
    expect(hasErrors([{ message: "bad", severity: "error" }])).toBe(true);
  });

  it("aggregates config-vs-compose validation warnings and reports parse failures as errors", async () => {
    mockFs.readFile.mockResolvedValue(composeContent);
    mockFs.stat.mockResolvedValue(createStat(1000, 200));
    const config = {
      sidecars: { mapping: { web: "web-ts" } },
      groups: { stack: ["web", "missing"] },
      profiles: {
        mapping: { web: "bad-profile", ghost: "all" },
        validProfiles: ["all"],
      },
    } as unknown as RfappsConfig;

    const warnings = await validateConfigAgainstCompose(config, "/path/to/compose.yml");

    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ context: "web-ts", severity: "warning" }),
        expect.objectContaining({ context: "stack", severity: "warning" }),
        expect.objectContaining({ context: "web", severity: "error" }),
        expect.objectContaining({ context: "db", severity: "warning" }),
        expect.objectContaining({ context: "ghost", severity: "warning" }),
      ]),
    );

    clearValidationCache();
    mockFs.readFile.mockRejectedValue(new Error("bad yaml"));
    await expect(validateConfigAgainstCompose(config, "/path/to/bad.yml")).resolves.toEqual([
      expect.objectContaining({
        message: expect.stringContaining("Failed to validate config:"),
        severity: "error",
      }),
    ]);
  });
});

const LOCAL_LAYER = "/repo/.rfapps.yaml";
const PROJECT_LAYER = "/repo/rfapps.config.yaml";
const MAPPING_YAML = ["tags:", "  mapping:", "    plex:", "      - media/streaming", ""].join("\n");

/** Serves the given layer paths from the mocked `listConfigLayerPaths` and `readFile`. */
function stubConfigLayers(
  layers: readonly string[],
  files: Readonly<Record<string, string>>,
): void {
  mockConfig.listConfigLayerPaths.mockResolvedValue([...layers]);
  mockFs.readFile.mockImplementation(async (path: string) => {
    const content = files[path];

    if (content === undefined) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }

    return content;
  });
}

describe("validateTagLayerOwnership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockConfig.listConfigLayerPaths.mockResolvedValue([]);
  });

  // `tags: {}` contributes no mapping, so `mergeConfig` and `TagIndex.source` both ignore it.
  // Counting it as a declaration made `rfapps validate` name it the winner and call the layer
  // that supplied the whole taxonomy "shadowed" — inverted, and a false positive besides.
  it("should ignore a layer whose tags block supplies no mapping", async () => {
    stubConfigLayers([LOCAL_LAYER, PROJECT_LAYER], {
      [LOCAL_LAYER]: "tags: {}\n",
      [PROJECT_LAYER]: MAPPING_YAML,
    });

    await expect(validateTagLayerOwnership("/repo")).resolves.toEqual([]);
  });

  it("should ignore a bare tags key with no value", async () => {
    stubConfigLayers([LOCAL_LAYER, PROJECT_LAYER], {
      [LOCAL_LAYER]: "tags:\n",
      [PROJECT_LAYER]: MAPPING_YAML,
    });

    await expect(validateTagLayerOwnership("/repo")).resolves.toEqual([]);
  });

  it("should name the highest-precedence mapping layer as the winner", async () => {
    stubConfigLayers([LOCAL_LAYER, PROJECT_LAYER], {
      [LOCAL_LAYER]: MAPPING_YAML,
      [PROJECT_LAYER]: MAPPING_YAML,
    });

    const warnings = await validateTagLayerOwnership("/repo");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.severity).toBe("warning");
    expect(warnings[0]?.context).toBe("tags");
    expect(warnings[0]?.message).toContain(`only '${LOCAL_LAYER}' takes effect`);
    expect(warnings[0]?.message).toContain(`shadowed: ${PROJECT_LAYER}`);
  });

  it("should not warn when a single layer supplies the mapping", async () => {
    stubConfigLayers([LOCAL_LAYER, PROJECT_LAYER], {
      [LOCAL_LAYER]: "groups: {}\n",
      [PROJECT_LAYER]: MAPPING_YAML,
    });

    await expect(validateTagLayerOwnership("/repo")).resolves.toEqual([]);
  });

  it("should return no warnings when layer discovery fails", async () => {
    mockConfig.listConfigLayerPaths.mockRejectedValue(new Error("no config"));

    await expect(validateTagLayerOwnership("/repo")).resolves.toEqual([]);
  });
});

// Omitting or misspelling the `mapping:` level is indistinguishable from having no taxonomy:
// `mergeConfig` reads exactly `override.tags?.mapping`, so the block merges to `{}`, `validate`
// reported success, and `--tag '!media'` matched every service in the project. `assertTagMapping`
// cannot see this — the stray keys are gone by then — so only the raw layer text has the evidence.
describe("validateTagLayerOwnership - unrecognized keys under tags:", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockConfig.listConfigLayerPaths.mockResolvedValue([]);
  });

  it("should warn when the mapping level is omitted and services sit under tags:", async () => {
    stubConfigLayers([PROJECT_LAYER], {
      [PROJECT_LAYER]: ["tags:", "  plex:", "    - media/streaming", ""].join("\n"),
    });

    const warnings = await validateTagLayerOwnership("/repo");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.severity).toBe("warning");
    expect(warnings[0]?.context).toBe("tags");
    expect(warnings[0]?.message).toContain(PROJECT_LAYER);
    expect(warnings[0]?.message).toContain("plex");
    expect(warnings[0]?.message).toContain("'mapping:'");
    expect(hasErrors(warnings)).toBe(false);
  });

  it("should warn on a misspelled mappings: key", async () => {
    stubConfigLayers([PROJECT_LAYER], {
      [PROJECT_LAYER]: ["tags:", "  mappings:", "    plex:", "      - media", ""].join("\n"),
    });

    const warnings = await validateTagLayerOwnership("/repo");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("mappings");
    expect(warnings[0]?.severity).toBe("warning");
  });

  it("should warn about a stray key alongside a valid mapping", async () => {
    stubConfigLayers([PROJECT_LAYER], {
      [PROJECT_LAYER]: `${MAPPING_YAML}  color: blue\n`,
    });

    const warnings = await validateTagLayerOwnership("/repo");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("color");
    expect(warnings[0]?.message).not.toContain("mapping,");
  });

  it("should warn when tags: is a scalar rather than a block", async () => {
    stubConfigLayers([PROJECT_LAYER], { [PROJECT_LAYER]: "tags: 42\n" });

    const warnings = await validateTagLayerOwnership("/repo");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.severity).toBe("warning");
    expect(warnings[0]?.message).toContain("a number");
  });

  it("should not warn for a clean mapping, an empty block, a bare key, or no block", async () => {
    for (const content of [MAPPING_YAML, "tags: {}\n", "tags:\n", "groups: {}\n"]) {
      stubConfigLayers([PROJECT_LAYER], { [PROJECT_LAYER]: content });

      await expect(validateTagLayerOwnership("/repo")).resolves.toEqual([]);
    }
  });

  it("should stay silent for a layer that cannot be read or parsed", async () => {
    stubConfigLayers([LOCAL_LAYER, PROJECT_LAYER], { [PROJECT_LAYER]: "tags: [\n" });

    await expect(validateTagLayerOwnership("/repo")).resolves.toEqual([]);
  });
});

describe("validateTagReferences - malformed mapping container", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // `Object.keys(42)` is `[]`, so before the container guard this produced an empty index and
  // `rfapps validate` printed "Configuration is valid" for a file that plainly is not.
  it.each([
    ["a number", 42],
    ["a boolean", true],
    ["an empty string", ""],
    ["a list", ["plex"]],
  ])("should report %s container as a warning rather than reporting success", (_label, value) => {
    const config = { tags: { mapping: value } } as unknown as RfappsConfig;

    const warnings = validateTagReferences(config, ["plex"], PROJECT_LAYER);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.severity).toBe("warning");
    expect(warnings[0]?.message).toContain("tags.mapping must be a mapping");
    // Warning severity is load-bearing: `validateConfigAgainstCompose` feeds `hasErrors`, and
    // `actions/deploy.ts` aborts on it, so an error here would block every deploy.
    expect(hasErrors(warnings)).toBe(false);
  });

  it("should stay silent for the legal no-taxonomy shapes", () => {
    for (const value of [null, {}]) {
      const config = { tags: { mapping: value } } as unknown as RfappsConfig;

      expect(validateTagReferences(config, ["plex"], PROJECT_LAYER)).toEqual([]);
    }
  });
});

describe("validateTagReferences - malformed mapping shape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // `buildTagIndex` now throws on a scalar mapping value. That must stay warning severity here,
  // because `validateConfigAgainstCompose` feeds `hasErrors`, which aborts `rfapps deploy`.
  it("should report a scalar mapping value as a warning, never an error", () => {
    const config = { tags: { mapping: { plex: "media" } } } as unknown as RfappsConfig;

    const warnings = validateTagReferences(config, ["plex"], PROJECT_LAYER);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.severity).toBe("warning");
    expect(warnings[0]?.message).toContain("Failed to validate tag mapping");
    expect(warnings[0]?.message).toContain("list of tag paths");
    expect(hasErrors(warnings)).toBe(false);
  });

  it("should report a non-string entry as a warning rather than crashing", () => {
    const config = {
      tags: { mapping: { plex: ["monitoring", 2024] } },
    } as unknown as RfappsConfig;

    const warnings = validateTagReferences(config, ["plex"], PROJECT_LAYER);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.severity).toBe("warning");
    expect(warnings[0]?.message).toContain("must be a string");
    expect(hasErrors(warnings)).toBe(false);
  });
});
