import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { formatError, handleCliError } from "@rfmedia/common";
import { registerRfappsErrorFormatters } from "./error-formatters.js";
import {
  ComposeFileParseError,
  ConfigNotFoundError,
  ConfigValidationError,
  DeploymentNotFoundError,
  DockerCommandError,
  EnvFileNotFoundError,
  GenerationNotFoundError,
  GroupNotFoundError,
  ImagePullError,
  InsufficientHistoryError,
  InvalidArgumentError,
  PlanValidationError,
  ProfileNotFoundError,
  ServiceNotFoundError,
  ServiceStartError,
  TagSelectorEmptyError,
} from "./errors.js";
import { ExitCode } from "./exit-codes.js";

beforeAll(() => {
  registerRfappsErrorFormatters();
});

describe("registerRfappsErrorFormatters", () => {
  it("formats every rfapps error contract", () => {
    const cases: ReadonlyArray<{
      error: Error;
      message: string;
      exitCode: number;
      suggestions: readonly string[];
    }> = [
      {
        error: new ServiceNotFoundError("plx", ["plex", "sonarr"]),
        message: "Service 'plx' not found",
        exitCode: ExitCode.UsageError,
        suggestions: [
          "Did you mean 'plex'?",
          "Available services: plex, sonarr",
          "Run rfapps status --all to see available services",
        ],
      },
      {
        error: new GroupNotFoundError("mdia", ["media", "core"]),
        message: "Unknown service group: 'mdia'",
        exitCode: ExitCode.UsageError,
        suggestions: ["Did you mean 'media'?", "Available groups: media, core"],
      },
      {
        error: new ProfileNotFoundError("cor", ["core", "media", "all"]),
        message: "Unknown profile: 'cor'",
        exitCode: ExitCode.UsageError,
        suggestions: ["Did you mean 'core'?", "Valid profiles: core, media, all"],
      },
      {
        error: new ConfigNotFoundError(["/home/user/.rfapps.yaml", "/project/.rfapps.yaml"]),
        message: "Configuration file not found",
        exitCode: ExitCode.OperationalError,
        suggestions: [
          "Searched paths: /home/user/.rfapps.yaml, /project/.rfapps.yaml",
          "Run rfapps init to create a configuration file",
        ],
      },
      {
        error: new EnvFileNotFoundError("--use-op", ".env"),
        message: "Environment file not found",
        exitCode: ExitCode.UsageError,
        suggestions: ["Provided path: .env", "Check the --use-op path"],
      },
      {
        error: new ConfigValidationError("composePath", ".rfapps.yaml", "Path does not exist"),
        message: "Invalid configuration: Path does not exist",
        exitCode: ExitCode.OperationalError,
        suggestions: [
          "Check the 'composePath' field in .rfapps.yaml",
          "Review .rfapps.yaml for configuration errors",
        ],
      },
      {
        error: new ComposeFileParseError("compose.yml", "Unexpected indent"),
        message: "Failed to parse compose file: Unexpected indent",
        exitCode: ExitCode.OperationalError,
        suggestions: ["Compose file: compose.yml", "Check YAML syntax and indentation"],
      },
      {
        error: new DeploymentNotFoundError("deploy-123", "plex"),
        message: "Deployment 'deploy-123' not found for service 'plex'",
        exitCode: ExitCode.OperationalError,
        suggestions: ["Run rfapps history to see available deployments"],
      },
      {
        error: new InsufficientHistoryError("plex", 5, 2),
        message: "Insufficient rollback history for 'plex'",
        exitCode: ExitCode.OperationalError,
        suggestions: [
          "Requested 5 step(s), but only 2 available",
          "Run rfapps history to see available deployments",
        ],
      },
      {
        error: new GenerationNotFoundError("plex", "generation 5"),
        message: "No generation found for service 'plex' matching generation 5",
        exitCode: ExitCode.OperationalError,
        suggestions: ["Run rfapps history --generations -s plex to see available generations"],
      },
      {
        error: new PlanValidationError("/path/plan.json", "Plan is stale"),
        message: "Plan validation failed: Plan is stale",
        exitCode: ExitCode.OperationalError,
        suggestions: ["Plan file: /path/plan.json", "Run rfapps plan to regenerate the plan"],
      },
      {
        error: new InvalidArgumentError("--output", "xml", "Invalid output format", [
          "json",
          "yaml",
          "csv",
        ]),
        message: "Invalid value 'xml' for --output: Invalid output format",
        exitCode: ExitCode.UsageError,
        suggestions: ["Valid values: json, yaml, csv"],
      },
      {
        error: new ImagePullError(["plex", "sonarr"], "timeout"),
        message: "Failed to pull images for plex, sonarr",
        exitCode: ExitCode.OperationalError,
        suggestions: ["Check network connectivity", "Verify image names in compose.yml"],
      },
      {
        error: new ServiceStartError(["plex", "sonarr"], "port conflict"),
        message: "Failed to start services: plex, sonarr",
        exitCode: ExitCode.OperationalError,
        suggestions: [
          "Check service logs with docker logs",
          "Run rfapps status for service health",
        ],
      },
      {
        error: new DockerCommandError("up", "ssh error", 1, ["plex"], true),
        message: "Docker up failed for plex",
        exitCode: ExitCode.OperationalError,
        suggestions: [
          "Check Docker daemon status",
          "Check SSH connection to the Docker host",
          "Verify Docker context configuration",
        ],
      },
    ];

    for (const testCase of cases) {
      const result = formatError(testCase.error);
      expect(result.message, testCase.error.name).toBe(testCase.message);
      expect(result.exitCode, testCase.error.name).toBe(testCase.exitCode);
      expect(result.originalError, testCase.error.name).toBe(testCase.error);
      expect(result.suggestions, testCase.error.name).toEqual(
        expect.arrayContaining([...testCase.suggestions]),
      );
      expect(result.suggestions.at(-1), testCase.error.name).toBe(
        "Run with --debug for more details",
      );
    }
  });

  it("omits conditional suggestions when their context is absent", () => {
    const cases = [
      {
        error: new ServiceNotFoundError(
          "unknown",
          Array.from({ length: 10 }, (_, index) => `service-${index}`),
        ),
        prefix: "Available services:",
      },
      { error: new GroupNotFoundError("unknown", []), prefix: "Available groups:" },
      { error: new ConfigNotFoundError([]), prefix: "Searched paths:" },
      {
        error: new InvalidArgumentError("--debug", "yes", "Must be a boolean"),
        prefix: "Valid values:",
      },
      {
        error: new DockerCommandError("up", "failed", 1, ["plex"], false),
        prefix: "Check SSH",
      },
    ];

    for (const testCase of cases) {
      expect(
        formatError(testCase.error).suggestions.some((suggestion) =>
          suggestion.startsWith(testCase.prefix),
        ),
        testCase.error.name,
      ).toBe(false);
    }
  });

  it("uses explicit and calculated lookup suggestions without false positives", () => {
    expect(
      formatError(new ServiceNotFoundError("plx", ["plex", "sonarr"], "sonarr")).suggestions,
    ).toContain("Did you mean 'sonarr'?");
    expect(formatError(new ServiceNotFoundError("plx", ["plex", "sonarr"])).suggestions).toContain(
      "Did you mean 'plex'?",
    );
    expect(
      formatError(new ServiceNotFoundError("zzzzzzzzz", ["plex", "sonarr"])).suggestions.some(
        (suggestion) => suggestion.startsWith("Did you mean"),
      ),
    ).toBe(false);
  });

  it("formats TagSelectorEmptyError in both its narrowing and stale-mapping shapes", () => {
    const knownTags = Array.from({ length: 14 }, (_, index) => `tag/${index}`);

    const narrowed = formatError(
      new TagSelectorEmptyError(
        ["media/automaton"],
        ["--group arr-stack"],
        knownTags,
        "media/automation",
      ),
    );
    expect(narrowed.message).toBe(
      [
        "Tag selector matched no services: media/automaton",
        "",
        "  The selector also included: --group arr-stack",
        "  --tag narrows the selection; it does not widen it.",
      ].join("\n"),
    );
    expect(narrowed.suggestions).toEqual([
      "Did you mean 'media/automation'?",
      "Run 'rfapps tag list' to see all 14 known tags",
      "Drop --group arr-stack to search all tagged services",
      "Run with --debug for more details",
    ]);
    expect(narrowed.exitCode).toBe(ExitCode.UsageError);

    const stale = formatError(
      new TagSelectorEmptyError(["media/streaming"], [], knownTags, undefined, [
        "plex-old",
        "jellyfin-legacy",
      ]),
    );
    expect(stale.message).toBe(
      [
        "Tag selector matched no services: media/streaming",
        "",
        "  'tags.mapping' assigns this tag to services that are absent from compose.yml:",
        "    plex-old, jellyfin-legacy",
      ].join("\n"),
    );
    expect(stale.suggestions).toEqual([
      "Remove the stale entries from tags.mapping in rfapps.config.yaml",
      "Run 'rfapps validate' to see every stale tag reference",
      "Run with --debug for more details",
    ]);
    expect(stale.exitCode).toBe(ExitCode.UsageError);

    const bare = formatError(new TagSelectorEmptyError(["media/**"], [], knownTags));
    expect(bare.message).toBe(
      [
        "Tag selector matched no services: media/**",
        "",
        "  --tag narrows the selection; it does not widen it.",
      ].join("\n"),
    );
    expect(bare.suggestions).toEqual([
      "Run 'rfapps tag list' to see all 14 known tags",
      "Run with --debug for more details",
    ]);
  });

  it("falls back safely for unknown and empty errors", () => {
    const unknown = new Error("Something unexpected happened");
    expect(formatError(unknown)).toEqual({
      message: "Something unexpected happened",
      suggestions: ["Run with --debug for more details"],
      exitCode: ExitCode.OperationalError,
      originalError: unknown,
    });
    expect(formatError(new Error(""))).toMatchObject({
      message: "An unexpected error occurred",
      exitCode: ExitCode.OperationalError,
    });

    for (const error of [new TypeError("type error"), new RangeError("range error")]) {
      const result = formatError(error);
      expect(result.message).toBeDefined();
      expect(result.suggestions).toBeInstanceOf(Array);
      expect(typeof result.exitCode).toBe("number");
    }
  });
});

describe("handleCliError integration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders representative usage, operational, SSH, and non-Error failures", () => {
    const exitMock = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cases: ReadonlyArray<{
      error: unknown;
      exitCode: number;
      output: readonly string[];
    }> = [
      {
        error: new ServiceNotFoundError("plx", ["plex", "sonarr"]),
        exitCode: ExitCode.UsageError,
        output: ["Service 'plx' not found"],
      },
      {
        error: new ConfigNotFoundError(["/path/.rfapps.yaml"]),
        exitCode: ExitCode.OperationalError,
        output: ["Suggestions:", "rfapps init"],
      },
      {
        error: new DockerCommandError("up", "ssh timeout", 1, ["plex"], true),
        exitCode: ExitCode.OperationalError,
        output: ["Docker up failed for plex", "SSH"],
      },
      {
        error: new InvalidArgumentError("--output", "xml", "Invalid format", ["json", "yaml"]),
        exitCode: ExitCode.UsageError,
        output: ["Invalid value 'xml' for --output", "json, yaml"],
      },
      {
        error: new InsufficientHistoryError("plex", 5, 2),
        exitCode: ExitCode.OperationalError,
        output: ["Insufficient rollback history", "5 step(s)", "2 available"],
      },
      {
        error: "string error",
        exitCode: ExitCode.OperationalError,
        output: ["string error"],
      },
    ];

    for (const testCase of cases) {
      vi.clearAllMocks();
      expect(() => handleCliError(testCase.error)).toThrow(`process.exit(${testCase.exitCode})`);
      expect(exitMock).toHaveBeenCalledWith(testCase.exitCode);
      const output = consoleErrorSpy.mock.calls.map((call) => String(call[0])).join("\n");
      for (const expected of testCase.output) {
        expect(output).toContain(expected);
      }
    }
  });
});
