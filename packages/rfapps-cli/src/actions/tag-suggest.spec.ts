/**
 * Contract tests for `rfapps tag suggest`.
 *
 * Three behaviors are pinned, and the first is the safety-critical one: the whole
 * surface exists to *propose* a taxonomy, so a run that quietly rewrote configuration
 * would be the worst possible bug in this feature.
 *
 * 1. **It writes nothing to configuration under any mode** — `--json`, text,
 *    `--include-tagged`, `--rule`, and degraded all assert `writeFile` /
 *    `writeFileSync` were never called.
 * 2. **`--out <existing path>` throws `InvalidArgumentError("--out", path, …)`** —
 *    exit 2, matching the only other `flag: "wx"` writer in the package
 *    (`actions/harden.ts`).
 * 3. **Local `--json` beats the global `--output` default** — `cli.ts` gives
 *    `--output` a `.default("text")`, so an inverted check makes `--json` dead.
 * 4. **The prose table separates its columns for every row** — fixed widths made
 *    `padEnd` a no-op on real fleet data and concatenated adjacent cells.
 *
 * The fragment string itself is deliberately untested (design §11): it is advisory
 * output, and the never-writes guarantee is what actually matters.
 */

import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

import * as config from "../lib/config.js";
import { InvalidArgumentError } from "../lib/errors.js";
import * as formatters from "../lib/formatters/index.js";
import * as tagIndex from "../lib/tags/tag-index.js";
import * as tagInference from "../lib/tags/tag-inference.js";
import { normalizeTag } from "../lib/tags/tag-path.js";
import * as validation from "../lib/validation.js";
import type { RfappsConfig } from "../types/config.js";
import type { TagIndex, TagPath, TagSuggestResult } from "../types/tags.js";
import { executeTagSuggest } from "./tag-suggest.js";

vi.mock("node:fs");
vi.mock("node:fs/promises");

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

vi.mock("../lib/tags/tag-inference.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tags/tag-inference.js")>();
  return { ...actual, inferTags: vi.fn() };
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

const FRAGMENT =
  "# Suggested by `rfapps tag suggest`.\ntags:\n  mapping:\n    plex:\n      - media/streaming\n";

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

function buildSuggestResult(overrides: Partial<TagSuggestResult> = {}): TagSuggestResult {
  return {
    schemaVersion: "tags.v1",
    proposals: [
      {
        service: "sonarr",
        tags: [normalizeTag("media/automation/arr"), normalizeTag("media/automation")],
        rules: ["tag-infer-arr", "tag-infer-profile"],
        confidence: "high",
        alreadyPresent: false,
      },
    ],
    unresolved: [],
    skippedRules: [],
    degraded: false,
    fragment: FRAGMENT,
    ...overrides,
  };
}

describe("executeTagSuggest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.mocked(config.loadConfig).mockResolvedValue(rfappsConfig);
    vi.mocked(validation.parseComposeFile).mockResolvedValue([...UNIVERSE]);
    vi.mocked(validation.validateServiceNames).mockResolvedValue(undefined);
    vi.mocked(tagIndex.getTagIndex).mockResolvedValue(buildIndex());
    vi.mocked(tagInference.inferTags).mockResolvedValue(buildSuggestResult());
    vi.mocked(formatters.formatOutput).mockResolvedValue(undefined);
  });

  describe("writes nothing to configuration", () => {
    it("writes nothing in text mode", async () => {
      await executeTagSuggest({}, { output: "text" });

      expect(fsPromises.writeFile).not.toHaveBeenCalled();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it("writes nothing in --json mode", async () => {
      await executeTagSuggest({ json: true }, { output: "text" });

      expect(fsPromises.writeFile).not.toHaveBeenCalled();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it("writes nothing with --include-tagged", async () => {
      await executeTagSuggest({ includeTagged: true }, { output: "text" });

      expect(vi.mocked(tagInference.inferTags).mock.calls[0]?.[2]).toMatchObject({
        includeTagged: true,
      });
      expect(fsPromises.writeFile).not.toHaveBeenCalled();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it("writes nothing with --rule", async () => {
      await executeTagSuggest({ rule: "tag-infer-ingress,tag-infer-arr" }, { output: "text" });

      expect(vi.mocked(tagInference.inferTags).mock.calls[0]?.[2]).toMatchObject({
        rules: ["tag-infer-ingress", "tag-infer-arr"],
      });
      expect(fsPromises.writeFile).not.toHaveBeenCalled();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it("writes nothing in degraded mode", async () => {
      vi.mocked(tagInference.inferTags).mockResolvedValue(
        buildSuggestResult({
          degraded: true,
          skippedRules: ["tag-infer-ingress", "tag-infer-tailnet"],
        }),
      );

      await executeTagSuggest({}, { output: "text" });

      expect(fsPromises.writeFile).not.toHaveBeenCalled();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it("writes nothing when --list-rules returns early", async () => {
      await executeTagSuggest({ listRules: true }, { output: "text" });

      expect(config.loadConfig).not.toHaveBeenCalled();
      expect(tagInference.inferTags).not.toHaveBeenCalled();
      expect(fsPromises.writeFile).not.toHaveBeenCalled();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe("--out", () => {
    it("writes the fragment non-clobberingly with flag 'wx'", async () => {
      vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);

      await executeTagSuggest({ out: "fragment.yaml" }, { output: "text" });

      expect(fsPromises.writeFile).toHaveBeenCalledTimes(1);
      expect(fsPromises.writeFile).toHaveBeenCalledWith("fragment.yaml", FRAGMENT, {
        encoding: "utf8",
        flag: "wx",
      });
      expect(process.stdout.write).not.toHaveBeenCalled();
    });

    it("throws InvalidArgumentError when the target already exists", async () => {
      const eexist = Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
      vi.mocked(fsPromises.writeFile).mockRejectedValue(eexist);

      await expect(executeTagSuggest({ out: "fragment.yaml" }, { output: "text" })).rejects.toThrow(
        InvalidArgumentError,
      );

      await executeTagSuggest({ out: "fragment.yaml" }, { output: "text" }).catch(
        (error: unknown) => {
          expect(error).toBeInstanceOf(InvalidArgumentError);
          const invalid = error as InvalidArgumentError;
          expect(invalid.argument).toBe("--out");
          expect(invalid.value).toBe("fragment.yaml");
          expect(invalid.reason).toBe("file already exists");
        },
      );
    });
  });

  describe("prose table", () => {
    /**
     * Rendered rows only: the header, the blank spacer, and every trailer line either
     * are unindented or start with a newline.
     */
    function tableLines(): string[] {
      return vi
        .mocked(console.error)
        .mock.calls.map((call) => String(call[0]))
        .filter((line) => line.startsWith(" "));
    }

    it("separates every column even when a cell overflows the widest other row", async () => {
      vi.mocked(tagInference.inferTags).mockResolvedValue(
        buildSuggestResult({
          proposals: [
            {
              // 19 characters — the longest service name in this repo, and exactly the
              // old fixed SERVICE_COLUMN, so padEnd contributed nothing.
              service: "forgejo-itcn-runner",
              tags: [normalizeTag("platform/infrastructure")],
              // 34 characters joined, well past the old fixed RULES_COLUMN of 21.
              rules: ["tag-infer-profile", "tag-infer-group"],
              confidence: "medium",
              alreadyPresent: false,
            },
            {
              service: "plex",
              tags: [normalizeTag("media/streaming"), normalizeTag("media")],
              rules: ["tag-infer-arr"],
              confidence: "high",
              alreadyPresent: true,
            },
          ],
        }),
      );

      await executeTagSuggest({}, { output: "text" });

      expect(tableLines()).toEqual([
        "  forgejo-itcn-runner  platform/infrastructure  tag-infer-profile, tag-infer-group  medium",
        "  plex                 media/streaming          tag-infer-arr                       high  (already effective)",
        "                       media",
      ]);
    });
  });

  describe("local --json beats the global --output default", () => {
    it("emits JSON when --json is set and --output is the 'text' default", async () => {
      await executeTagSuggest({ json: true }, { output: "text" });

      expect(formatters.formatOutput).toHaveBeenCalledTimes(1);
      const [format, payload] = vi.mocked(formatters.formatOutput).mock.calls[0] ?? [];
      expect(format).toBe("json");
      expect(payload).toMatchObject({ schemaVersion: "tags.v1", degraded: false });
      expect(process.stdout.write).not.toHaveBeenCalled();
    });

    it("renders text and calls no formatter when --json is absent", async () => {
      await executeTagSuggest({}, { output: "text" });

      expect(formatters.formatOutput).not.toHaveBeenCalled();
      expect(process.stdout.write).toHaveBeenCalledWith(FRAGMENT);
    });
  });
});
