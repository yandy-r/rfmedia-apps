import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeStatus } from "./status.js";
import * as lib from "../lib/index.js";
import * as common from "@rfmedia/common";
import { TagSelectorEmptyError } from "../lib/errors.js";
import { normalizeTag } from "../lib/tags/tag-path.js";
import { parseTagTerm } from "../lib/tags/tag-pattern.js";
import type { TagIndex, TagPath } from "../types/index.js";

// Mock dependencies
vi.mock("../lib/index.js");
// `errors.ts` is dependency-free by repo convention, so the real module loads safely here.
// Only `DockerCommandError` is stubbed (the local-formatting path asserts on it); every
// other class — including `TagSelectorEmptyError` — stays real so `rejects.toThrow(...)`
// checks a genuine instance rather than an automocked shell.
vi.mock("../lib/errors.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/errors.js")>();

  return {
    ...actual,
    DockerCommandError: class DockerCommandError extends Error {
      readonly operation: string;
      readonly stderr: string;
      readonly exitCode: number;
      readonly services: string[];
      readonly isSSH: boolean;
      constructor(
        operation: string,
        stderr: string,
        exitCode: number,
        services: string[],
        isSSH: boolean,
      ) {
        super(`Docker ${operation} failed for ${services.join(", ")}`);
        this.name = "DockerCommandError";
        this.operation = operation;
        this.stderr = stderr;
        this.exitCode = exitCode;
        this.services = services;
        this.isSSH = isSSH;
      }
    },
  };
});
vi.mock("@rfmedia/common");

describe("Status Action", () => {
  const mockConfig = {
    composePath: "compose.yml",
    profiles: { defaultProfile: "core" },
    sidecars: { enabled: true },
  };

  const mockContainerLine = JSON.stringify({
    ID: "abc123def456",
    Image: "traefik:v3.0",
    Command: "/entrypoint.sh",
    CreatedAt: "2025-01-01T00:00:00Z",
    RunningFor: "2 days",
    Ports: "80/tcp, 443/tcp",
    State: "running",
    Status: "Up 2 days (healthy)",
    Size: "0B",
    Names: "traefik",
    Labels: "",
    Mounts: "",
    Networks: "apps",
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(lib.loadConfig).mockResolvedValue(mockConfig as any);
    vi.mocked(lib.applyCliOverrides).mockReturnValue(mockConfig as any);
    vi.mocked(lib.formatOutput).mockResolvedValue(undefined);
  });

  describe("format dispatch", () => {
    it("should call formatOutput with json format when --output json is passed", async () => {
      vi.mocked(lib.listContainers).mockResolvedValue({
        success: true,
        stdout: mockContainerLine,
        stderr: "",
        code: 0,
      });

      await executeStatus({}, { output: "json" });

      expect(lib.formatOutput).toHaveBeenCalledWith(
        "json",
        expect.objectContaining({
          total: 1,
          running: 1,
          healthy: 1,
          services: expect.arrayContaining([
            expect.objectContaining({
              name: "traefik",
              state: "running",
              health: "healthy",
              image: "traefik",
              tag: "v3.0",
            }),
          ]),
        }),
      );
    });

    it("should call formatOutput with yaml format when --output yaml is passed", async () => {
      vi.mocked(lib.listContainers).mockResolvedValue({
        success: true,
        stdout: mockContainerLine,
        stderr: "",
        code: 0,
      });

      await executeStatus({}, { output: "yaml" });

      expect(lib.formatOutput).toHaveBeenCalledWith(
        "yaml",
        expect.objectContaining({
          total: 1,
          running: 1,
        }),
      );
    });

    it("should call formatOutput with csv format when --output csv is passed", async () => {
      vi.mocked(lib.listContainers).mockResolvedValue({
        success: true,
        stdout: mockContainerLine,
        stderr: "",
        code: 0,
      });

      await executeStatus({}, { output: "csv" });

      expect(lib.formatOutput).toHaveBeenCalledWith(
        "csv",
        expect.objectContaining({
          total: 1,
        }),
      );
    });

    it("should not call formatOutput for text format (default)", async () => {
      vi.mocked(lib.listContainers).mockResolvedValue({
        success: true,
        stdout: mockContainerLine,
        stderr: "",
        code: 0,
      });

      await executeStatus({}, {});

      expect(lib.formatOutput).not.toHaveBeenCalled();
      expect(common.logSuccess).toHaveBeenCalledWith("Status check complete");
    });

    it("should render human-readable output for text format", async () => {
      vi.mocked(lib.listContainers).mockResolvedValue({
        success: true,
        stdout: mockContainerLine,
        stderr: "",
        code: 0,
      });

      await executeStatus({}, {});

      // Text format renders via console.error, not formatOutput
      expect(lib.formatOutput).not.toHaveBeenCalled();
      expect(common.logSuccess).toHaveBeenCalledWith("Status check complete");
    });
  });

  describe("error handling", () => {
    it("should handle container list failure", async () => {
      vi.mocked(lib.listContainers).mockResolvedValue({
        success: false,
        stdout: "",
        stderr: "docker not available",
        code: 1,
      });
      vi.mocked(common.formatError).mockReturnValue({
        message: "Docker status failed",
        suggestions: [],
        exitCode: 1,
        originalError: new Error("Docker status failed"),
      });

      await executeStatus({}, {});

      expect(common.formatError).toHaveBeenCalled();
      expect(common.outputFormattedError).toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it("should call formatOutput on error with machine format", async () => {
      vi.mocked(lib.listContainers).mockResolvedValue({
        success: false,
        stdout: "",
        stderr: "docker not available",
        code: 1,
      });
      vi.mocked(common.isMachineFormat).mockReturnValue(true);

      await executeStatus({}, { output: "json" });

      expect(lib.formatOutput).toHaveBeenCalledWith("json", { error: "docker not available" });
      expect(process.exitCode).toBe(1);
    });

    it("should not call formatOutput on error with text format", async () => {
      vi.mocked(lib.listContainers).mockResolvedValue({
        success: false,
        stdout: "",
        stderr: "docker not available",
        code: 1,
      });
      vi.mocked(common.isMachineFormat).mockReturnValue(false);

      await executeStatus({}, {});

      expect(lib.formatOutput).not.toHaveBeenCalled();
    });
  });

  describe("dry-run mode", () => {
    it("should show dry-run message and return early", async () => {
      await executeStatus({}, { dryRun: true });

      expect(common.logInfo).toHaveBeenCalled();
      expect(lib.listContainers).not.toHaveBeenCalled();
    });
  });

  describe("empty results", () => {
    it("should show info message when no containers found", async () => {
      vi.mocked(lib.listContainers).mockResolvedValue({
        success: true,
        stdout: "",
        stderr: "",
        code: 0,
      });

      await executeStatus({}, {});

      expect(common.logInfo).toHaveBeenCalledWith("No containers found");
    });
  });

  describe("service filtering", () => {
    it("should filter containers by service name", async () => {
      const multiLine = [
        JSON.stringify({
          ID: "abc123",
          Image: "traefik:v3.0",
          Command: "",
          CreatedAt: "",
          RunningFor: "",
          Ports: "",
          State: "running",
          Status: "Up (healthy)",
          Size: "",
          Names: "traefik",
          Labels: "",
          Mounts: "",
          Networks: "",
        }),
        JSON.stringify({
          ID: "def456",
          Image: "plex:latest",
          Command: "",
          CreatedAt: "",
          RunningFor: "",
          Ports: "",
          State: "running",
          Status: "Up",
          Size: "",
          Names: "plex",
          Labels: "",
          Mounts: "",
          Networks: "",
        }),
      ].join("\n");

      vi.mocked(lib.listContainers).mockResolvedValue({
        success: true,
        stdout: multiLine,
        stderr: "",
        code: 0,
      });

      await executeStatus({ service: "traefik" }, { output: "json" });

      expect(lib.formatOutput).toHaveBeenCalledWith(
        "json",
        expect.objectContaining({
          total: 1,
          services: expect.arrayContaining([expect.objectContaining({ name: "traefik" })]),
        }),
      );
    });
  });

  describe("tag filtering", () => {
    const UNIVERSE = ["traefik", "plex", "sonarr"];

    /**
     * A minimal `TagIndex`. `status.ts` reads `allTags`, `effective` and
     * `unresolvedServices` (all on the `TagSelectorEmptyError` path) because `applyTagAxis`
     * is mocked here; `normalizeTag` mints the branded `TagPath` values, never a cast.
     */
    const tagIndex: TagIndex = {
      declared: new Map<string, readonly TagPath[]>(),
      effective: new Map<string, ReadonlySet<TagPath>>(),
      byTag: new Map<TagPath, readonly string[]>(),
      allTags: [normalizeTag("media"), normalizeTag("media/streaming")],
      declaredTags: new Set<TagPath>(),
      unresolvedServices: [],
      source: "rfapps.config.yaml",
    };

    /**
     * The same index plus one stale `tags.mapping` entry: `retired-service` is absent from
     * `UNIVERSE` and carries only `hardware/gpu`. `effective` must be populated for it —
     * that is what makes "would this pattern really have matched the stale entry?"
     * computable rather than a global yes/no.
     */
    const staleTagIndex: TagIndex = {
      ...tagIndex,
      effective: new Map<string, ReadonlySet<TagPath>>([
        ["retired-service", new Set([normalizeTag("hardware"), normalizeTag("hardware/gpu")])],
      ]),
      allTags: [
        normalizeTag("hardware"),
        normalizeTag("hardware/gpu"),
        normalizeTag("media"),
        normalizeTag("media/automation"),
        normalizeTag("media/streaming"),
      ],
      unresolvedServices: ["retired-service"],
    };

    const twoContainerLines = [
      JSON.stringify({
        ID: "abc123",
        Image: "traefik:v3.0",
        Command: "",
        CreatedAt: "",
        RunningFor: "",
        Ports: "",
        State: "running",
        Status: "Up (healthy)",
        Size: "",
        Names: "traefik",
        Labels: "",
        Mounts: "",
        Networks: "",
      }),
      JSON.stringify({
        ID: "def456",
        Image: "plex:latest",
        Command: "",
        CreatedAt: "",
        RunningFor: "",
        Ports: "",
        State: "running",
        Status: "Up",
        Size: "",
        Names: "plex",
        Labels: "",
        Mounts: "",
        Networks: "",
      }),
    ].join("\n");

    beforeEach(() => {
      vi.mocked(lib.parseComposeFile).mockResolvedValue(UNIVERSE);
      vi.mocked(lib.getTagIndex).mockResolvedValue(tagIndex);
      vi.mocked(lib.explicitSelectorFlagNames).mockReturnValue([]);
      // A sentinel, not `undefined`: `status.ts` must no longer route the suggestion
      // through this barrel export. If the pre-fix
      // `findClosestTag(axis.terms[0].source)` call came back, the diagnosis assertions
      // below would see this string instead of the real answer.
      vi.mocked(lib.findClosestTag).mockReturnValue("SHOULD-NOT-BE-USED");
    });

    it("should not touch the tag subsystem when --tag is absent (P1)", async () => {
      vi.mocked(lib.listContainers).mockResolvedValue({
        success: true,
        stdout: twoContainerLines,
        stderr: "",
        code: 0,
      });

      await executeStatus({}, { output: "json" });

      // P1 is structural for the hottest command: no compose parse, no tag index, and
      // therefore no way for a malformed `tags.mapping` entry to break `rfapps status`.
      expect(lib.parseComposeFile).not.toHaveBeenCalled();
      expect(lib.getTagIndex).not.toHaveBeenCalled();
      expect(lib.applyTagAxis).not.toHaveBeenCalled();
      expect(lib.formatOutput).toHaveBeenCalledWith("json", expect.objectContaining({ total: 2 }));
    });

    it("should filter docker ps rows down to the matched services", async () => {
      vi.mocked(lib.listContainers).mockResolvedValue({
        success: true,
        stdout: twoContainerLines,
        stderr: "",
        code: 0,
      });
      vi.mocked(lib.applyTagAxis).mockReturnValue({
        kind: "present",
        terms: [parseTagTerm("media/**")],
        matched: new Set(["plex", "sonarr"]),
      });

      await executeStatus({ tag: ["media/**"] }, { output: "json" });

      expect(lib.formatOutput).toHaveBeenCalledWith(
        "json",
        expect.objectContaining({
          total: 1,
          services: [expect.objectContaining({ name: "plex" })],
        }),
      );
    });

    it("should throw TagSelectorEmptyError when the tag matches nothing", async () => {
      vi.mocked(lib.listContainers).mockResolvedValue({
        success: true,
        stdout: twoContainerLines,
        stderr: "",
        code: 0,
      });
      vi.mocked(lib.applyTagAxis).mockReturnValue({
        kind: "present",
        terms: [parseTagTerm("typoo/**")],
        matched: new Set<string>(),
      });

      // Never `[]`: falling through to the "no explicit target" sentinel would report
      // every container instead of failing (P2).
      await expect(executeStatus({ tag: ["typoo/**"] }, { output: "json" })).rejects.toThrow(
        TagSelectorEmptyError,
      );
      expect(lib.formatOutput).not.toHaveBeenCalled();
    });

    it("should intersect --tag with -s rather than letting -s win", async () => {
      vi.mocked(lib.listContainers).mockResolvedValue({
        success: true,
        stdout: twoContainerLines,
        stderr: "",
        code: 0,
      });
      vi.mocked(lib.applyTagAxis).mockReturnValue({
        kind: "present",
        terms: [parseTagTerm("media/**")],
        matched: new Set(["plex", "sonarr"]),
      });

      // `status --tag "media/**" -s traefik` must behave exactly like
      // `rebuild --tag "media/**" -s traefik`: traefik is untagged, so the intersection
      // is empty and the command fails instead of silently reporting traefik.
      await expect(
        executeStatus({ service: "traefik", tag: ["media/**"] }, { output: "json" }),
      ).rejects.toThrow(TagSelectorEmptyError);
    });

    describe("the empty-selection diagnosis is accurate", () => {
      async function captureTagError(
        options: Parameters<typeof executeStatus>[0],
      ): Promise<TagSelectorEmptyError> {
        vi.mocked(lib.listContainers).mockResolvedValue({
          success: true,
          stdout: twoContainerLines,
          stderr: "",
          code: 0,
        });

        let caught: unknown;

        try {
          await executeStatus(options, { output: "json" });
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(TagSelectorEmptyError);

        return caught as TagSelectorEmptyError;
      }

      it("does not blame stale tags.mapping entries carrying unrelated tags", async () => {
        vi.mocked(lib.getTagIndex).mockResolvedValue(staleTagIndex);
        vi.mocked(lib.applyTagAxis).mockReturnValue({
          kind: "present",
          terms: [parseTagTerm("media/automaton")],
          matched: new Set<string>(),
        });

        // `retired-service` carries only `hardware/gpu`, so "tags.mapping assigns THIS tag
        // to services absent from compose.yml" is false — and naming it suppressed the
        // fuzzy suggestion that was the real diagnosis.
        const error = await captureTagError({ tag: ["media/automaton"] });

        expect(error.unresolvedServices).toEqual([]);
        expect(error.suggestion).toBe("media/automation");
      });

      it("still blames stale entries the patterns genuinely select", async () => {
        vi.mocked(lib.getTagIndex).mockResolvedValue(staleTagIndex);
        vi.mocked(lib.applyTagAxis).mockReturnValue({
          kind: "present",
          terms: [parseTagTerm("hardware/**")],
          matched: new Set<string>(),
        });

        const error = await captureTagError({ tag: ["hardware/**"] });

        expect(error.unresolvedServices).toEqual(["retired-service"]);
      });

      it("never suggests a tag the operator already typed correctly", async () => {
        vi.mocked(lib.applyTagAxis).mockReturnValue({
          kind: "present",
          terms: [parseTagTerm("media/streaming")],
          matched: new Set(["plex"]),
        });

        // An empty INTERSECTION, not an unknown tag: `media/streaming` exists and matched
        // plex; `-s traefik` is what emptied it. computeSimilarity of a string with itself
        // is 1.0, so the unconditional call echoed the operator's own input back.
        const error = await captureTagError({ service: "traefik", tag: ["media/streaming"] });

        expect(error.suggestion).toBeUndefined();
        expect(error.unresolvedServices).toEqual([]);
      });
    });
  });
});
