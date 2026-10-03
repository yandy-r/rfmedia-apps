import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import yaml from "js-yaml";
import { buildConfigTemplate, mergeConfigs, writeConfigTemplate } from "./config.js";
import type { ConfigFile } from "../types/index.js";

describe("config init merge behavior", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-init-merge-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("preserves filters, plexFilters, plugins, and unknown top-level keys", () => {
    const existing = {
      copy: { workers: 8 },
      filters: {
        customLiked: {
          match: "all",
          rules: [{ type: "rule", field: "rating", operator: ">=", value: 4 }],
        },
      },
      plexFilters: {
        customPlex: {
          match: "all",
          library: "Music",
          type: "track",
          rules: [{ type: "rule", field: "trackRating", operator: ">=", value: 4 }],
        },
      },
      plugins: {
        enabled: false,
      },
      customSection: {
        enabled: true,
      },
    } as unknown as ConfigFile & Record<string, unknown>;

    const merged = mergeConfigs(existing, buildConfigTemplate()) as ConfigFile &
      Record<string, unknown>;

    expect(merged.filters).toEqual(existing.filters);
    expect(merged.plexFilters).toEqual(existing.plexFilters);
    expect(merged.plugins).toEqual(existing.plugins);
    expect(merged["customSection"]).toEqual({ enabled: true });
    expect(merged.clean).toBeDefined();
  });

  it("uses template filters only when existing config has no filters key", () => {
    const existing: ConfigFile = {
      copy: { workers: 2 },
    };

    const merged = mergeConfigs(existing, buildConfigTemplate());
    expect(merged.filters).toEqual(buildConfigTemplate().filters);
  });

  it("preserves empty filter sections when keys exist", () => {
    const existing = {
      filters: {},
      plexFilters: {},
    } as ConfigFile;

    const merged = mergeConfigs(existing, buildConfigTemplate());
    expect(merged.filters).toEqual({});
    expect(merged.plexFilters).toEqual({});
  });

  it("does not preserve null filters or plexFilters; uses template defaults instead", () => {
    const existing = {
      copy: { workers: 2 },
      filters: null,
      plexFilters: null,
    } as unknown as ConfigFile & Record<string, unknown>;

    const template = buildConfigTemplate();
    const merged = mergeConfigs(existing, template);

    expect(merged.filters).toEqual(template.filters);
    expect(merged.filters).not.toBeNull();
    expect(merged.plexFilters).toBeUndefined();
  });

  it("does not preserve null filters when plexFilters is valid", () => {
    const existing = {
      copy: { workers: 2 },
      filters: null,
      plexFilters: {
        keep: {
          match: "all",
          library: "Music",
          type: "track",
          rules: [{ type: "rule", field: "trackRating", operator: ">=", value: 4 }],
        },
      },
    } as unknown as ConfigFile & Record<string, unknown>;

    const template = buildConfigTemplate();
    const merged = mergeConfigs(existing, template);

    expect(merged.filters).toEqual(template.filters);
    expect(merged.filters).not.toBeNull();
    expect(merged.plexFilters).toEqual(existing.plexFilters);
  });

  it("does not preserve null plexFilters when filters is valid", () => {
    const existing = {
      copy: { workers: 2 },
      filters: {
        keep: {
          match: "all",
          rules: [{ type: "rule", field: "rating", operator: ">=", value: 3 }],
        },
      },
      plexFilters: null,
    } as unknown as ConfigFile & Record<string, unknown>;

    const template = buildConfigTemplate();
    const merged = mergeConfigs(existing, template);

    expect(merged.filters).toEqual(existing.filters);
    expect(merged.plexFilters).toBeUndefined();
  });

  it("appends a commented YAML filter example block when merging existing filter sections", async () => {
    const configPath = join(tempDir, ".rfmedia.yaml");
    const initialConfig = `
copy:
  workers: 9
filters:
  keep-me:
    match: all
    rules:
      - type: rule
        field: rating
        operator: ">="
        value: 3
plexFilters:
  keep-me-too:
    match: all
    library: Music
    type: track
    rules:
      - type: rule
        field: trackRating
        operator: ">="
        value: 3
customSection:
  keep: true
`;
    await writeFile(configPath, initialConfig.trimStart(), "utf-8");

    await writeConfigTemplate(configPath, false, true);
    const firstPass = await readFile(configPath, "utf-8");

    expect(firstPass).toContain("rfmedia init filter examples (commented)");
    expect(firstPass).toContain("# filters:");
    expect(firstPass).toContain("# plexFilters:");
    expect(firstPass).toContain("keep-me:");
    expect(firstPass).toContain("keep-me-too:");
    expect(firstPass).toContain("customSection:");

    await writeConfigTemplate(configPath, false, true);
    const secondPass = await readFile(configPath, "utf-8");
    const markerCount =
      secondPass.match(/rfmedia init filter examples \(commented\)/g)?.length ?? 0;

    expect(markerCount).toBe(1);
  });

  it("does not append comment blocks for JSON configs and preserves unknown keys", async () => {
    const configPath = join(tempDir, ".rfmedia.json");
    const initialConfig = {
      copy: { workers: 7 },
      filters: {
        jsonFilter: {
          match: "all",
          rules: [{ type: "rule", field: "rating", operator: ">=", value: 4 }],
        },
      },
      customJsonKey: {
        keep: true,
      },
    };
    await writeFile(configPath, JSON.stringify(initialConfig, null, 2), "utf-8");

    await writeConfigTemplate(configPath, false, true);
    const content = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(content) as ConfigFile & Record<string, unknown>;

    expect(content).not.toContain("rfmedia init filter examples (commented)");
    expect(parsed.filters).toEqual(initialConfig.filters);
    expect(parsed["customJsonKey"]).toEqual({ keep: true });
  });

  it("preserves unknown keys when merged YAML is parsed back", async () => {
    const configPath = join(tempDir, ".rfmedia.yaml");
    const initialConfig = `
filters:
  keep:
    match: all
    rules:
      - type: rule
        field: rating
        operator: ">="
        value: 3
myFutureConfig:
  one: 1
  two: 2
`;
    await writeFile(configPath, initialConfig.trimStart(), "utf-8");

    await writeConfigTemplate(configPath, false, true);
    const content = await readFile(configPath, "utf-8");
    const parsed = yaml.load(content, { schema: yaml.CORE_SCHEMA }) as Record<string, unknown>;

    expect(parsed["myFutureConfig"]).toEqual({ one: 1, two: 2 });
  });

  it("init --merge with bare filters: and plexFilters: writes valid filter sections (no null)", async () => {
    const configPath = join(tempDir, ".rfmedia.yaml");
    const initialConfig = `
copy:
  workers: 2
filters:
plexFilters:
`;
    await writeFile(configPath, initialConfig.trimStart(), "utf-8");

    await writeConfigTemplate(configPath, false, true);
    const content = await readFile(configPath, "utf-8");
    const raw = yaml.load(content, { schema: yaml.CORE_SCHEMA }) as Record<string, unknown>;

    expect(raw["filters"]).not.toBeNull();
    expect(raw["filters"]).toBeDefined();
    expect(typeof raw["filters"]).toBe("object");
    expect(Array.isArray(raw["filters"])).toBe(false);
    if (raw["plexFilters"] !== undefined) {
      expect(raw["plexFilters"]).not.toBeNull();
      expect(typeof raw["plexFilters"]).toBe("object");
      expect(Array.isArray(raw["plexFilters"])).toBe(false);
    }
  });
});
