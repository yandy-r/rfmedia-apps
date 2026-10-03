/**
 * Contract tests for the read-only `tag list` / `tag show` actions.
 *
 * Two behaviors are pinned here and nothing else — the tree and per-service text
 * renders are cosmetic and deliberately untested (design §11):
 *
 * 1. **Local `--json` beats the global `--output` default.** `cli.ts` declares the
 *    global `--output` with `.default("text")`, so `globalOptions.output` is never
 *    `undefined`. Checking it before the local flag makes `--json` permanently dead,
 *    and nothing else in the suite would notice.
 * 2. **`--output csv` is rejected.** Both result shapes nest arrays inside rows; CSV
 *    would flatten them into an ambiguous string rather than fail.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import * as config from "../lib/config.js";
import { InvalidArgumentError } from "../lib/errors.js";
import * as formatters from "../lib/formatters/index.js";
import * as tagIndex from "../lib/tags/tag-index.js";
import { normalizeTag } from "../lib/tags/tag-path.js";
import * as validation from "../lib/validation.js";
import type { RfappsConfig } from "../types/config.js";
import type { TagIndex, TagPath } from "../types/tags.js";
import { executeTagList, executeTagShow } from "./tag.js";

vi.mock("../lib/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/config.js")>();
  return { ...actual, loadConfig: vi.fn() };
});

vi.mock("../lib/validation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/validation.js")>();
  return { ...actual, parseComposeFile: vi.fn(), validateServiceNames: vi.fn() };
});

vi.mock("../lib/tags/tag-index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tags/tag-index.js")>();
  return { ...actual, getTagIndex: vi.fn() };
});

vi.mock("../lib/formatters/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/formatters/index.js")>();
  return { ...actual, formatOutput: vi.fn().mockResolvedValue(undefined) };
});

const rfappsConfig: RfappsConfig = {
  composePath: "/repo/compose.yml",
  envFile: "/repo/.env",
  profiles: { defaultProfile: "all", validProfiles: ["all", "media"], mapping: { plex: "media" } },
  sidecars: { enabled: false, mapping: {} },
  groups: { "media-stack": ["plex"] },
  healthCheck: { timeout: 30, interval: 5, retries: 3, waitForReady: true },
  envTool: { tool: "none" },
  docker: {},
  interactive: { pageSize: 10 },
  state: { enabled: true },
  parallel: { enabled: false, workers: 4 },
  lint: { ignore: [] },
};

const UNIVERSE = ["plex", "sonarr"];

/**
 * A hand-built index, minted through `normalizeTag` rather than cast, so the branded
 * `TagPath` invariant holds in the fixture too.
 */
function buildIndex(): TagIndex {
  const media = normalizeTag("media");
  const streaming = normalizeTag("media/streaming");

  return {
    declared: new Map<string, readonly TagPath[]>([["plex", [streaming]]]),
    effective: new Map<string, ReadonlySet<TagPath>>([
      ["plex", new Set([media, streaming])],
      ["sonarr", new Set<TagPath>()],
    ]),
    byTag: new Map<TagPath, readonly string[]>([
      [media, ["plex"]],
      [streaming, ["plex"]],
    ]),
    allTags: [media, streaming],
    declaredTags: new Set([streaming]),
    unresolvedServices: [],
    source: "/repo/rfapps.config.yaml",
  };
}

describe("tag inspection actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(config.loadConfig).mockResolvedValue(rfappsConfig);
    vi.mocked(validation.parseComposeFile).mockResolvedValue([...UNIVERSE]);
    vi.mocked(validation.validateServiceNames).mockResolvedValue(undefined);
    vi.mocked(tagIndex.getTagIndex).mockResolvedValue(buildIndex());
    vi.mocked(formatters.formatOutput).mockResolvedValue(undefined);
  });

  describe("local --json beats the global --output default", () => {
    it("emits JSON from executeTagList when --json is set and --output is the 'text' default", async () => {
      await executeTagList({ json: true }, { output: "text" });

      expect(formatters.formatOutput).toHaveBeenCalledTimes(1);
      const [format, payload] = vi.mocked(formatters.formatOutput).mock.calls[0] ?? [];
      expect(format).toBe("json");
      expect(payload).toMatchObject({ schemaVersion: "tags.v1", totalTags: 2, totalServices: 1 });
    });

    it("emits JSON from executeTagShow when --json is set and --output is the 'text' default", async () => {
      await executeTagShow({ service: "plex", json: true }, { output: "text" });

      expect(formatters.formatOutput).toHaveBeenCalledTimes(1);
      const [format, payload] = vi.mocked(formatters.formatOutput).mock.calls[0] ?? [];
      expect(format).toBe("json");
      expect(payload).toMatchObject({
        schemaVersion: "tags.v1",
        services: [
          {
            service: "plex",
            declaredTags: ["media/streaming"],
            effectiveTags: ["media", "media/streaming"],
          },
        ],
      });
    });

    it("renders text and calls no formatter when --json is absent", async () => {
      await executeTagList({}, { output: "text" });

      expect(formatters.formatOutput).not.toHaveBeenCalled();
    });
  });

  describe("--output csv is rejected", () => {
    it("rejects csv for executeTagList", async () => {
      await expect(executeTagList({}, { output: "csv" })).rejects.toThrow(InvalidArgumentError);

      await executeTagList({}, { output: "csv" }).catch((error: unknown) => {
        expect(error).toBeInstanceOf(InvalidArgumentError);
        const invalid = error as InvalidArgumentError;
        expect(invalid.argument).toBe("--output");
        expect(invalid.value).toBe("csv");
        expect(invalid.reason).toBe("Tag output is hierarchical; use json, yaml, or table");
      });

      expect(formatters.formatOutput).not.toHaveBeenCalled();
    });

    it("rejects csv for executeTagShow", async () => {
      await expect(executeTagShow({ service: "plex" }, { output: "csv" })).rejects.toThrow(
        InvalidArgumentError,
      );

      await executeTagShow({ service: "plex" }, { output: "csv" }).catch((error: unknown) => {
        expect(error).toBeInstanceOf(InvalidArgumentError);
        const invalid = error as InvalidArgumentError;
        expect(invalid.argument).toBe("--output");
        expect(invalid.value).toBe("csv");
      });

      expect(formatters.formatOutput).not.toHaveBeenCalled();
    });
  });
});
