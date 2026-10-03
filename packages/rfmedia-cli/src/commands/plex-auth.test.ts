/**
 * Surface tests for the `rfmedia plex auth …` command group (issue #251).
 *
 * Deliberately minimal — three cases, each covering something no other test in
 * the tree can. The behaviour of the verbs themselves lives in the store,
 * enrollment, and provider suites; what is proven here is the Commander wiring.
 *
 * The middle case is the important one. A Commander `argParser` that throws
 * `InvalidArgumentError` is routed through `Command.error()` → `process.exit(1)`
 * *before* `.action()` runs, so a single `.argParser(...)` added later would
 * silently bypass the failure envelope, the redaction pass, and the exit-code
 * contract — while every other test kept passing.
 *
 * IMPORTANT: uses vi.clearAllMocks() in beforeEach(), NOT vi.resetAllMocks().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

const mockAuthActions = vi.hoisted(() => ({
  executePlexAuthLogin: vi.fn(),
  executePlexAuthStatus: vi.fn(),
  executePlexAuthRefresh: vi.fn(),
  executePlexAuthLogout: vi.fn(),
  buildPlexAuthFailureEnvelope: vi.fn((verb: string) => ({
    command: `plex-auth-${verb}`,
    error: {
      message: "redacted failure message",
      code: "PLEX_AUTH_ARGUMENT_INVALID",
      retryable: false,
      retryAfterSeconds: null,
      statusCode: null,
      remediation: "Correct the reported option value, then run the command again.",
    },
  })),
}));

const mockFormatters = vi.hoisted(() => ({
  formatOutput: vi.fn().mockResolvedValue(undefined),
}));

const mockLogger = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
  logSuccess: vi.fn(),
  outputJson: vi.fn(),
}));

vi.mock("../actions/plex-auth.js", () => mockAuthActions);
vi.mock("../lib/formatters/index.js", () => mockFormatters);
vi.mock("../lib/logger.js", () => mockLogger);

// Import after mocks so the lazy action import resolves to the mock.
import { plexAuthCommand } from "./plex-auth.js";

/** Rebuilds the real `rfmedia → plex → auth` chain around the shared group. */
function mountAuthCommand(): Command {
  const root = new Command("rfmedia");
  root.option("--json", "Output in JSON format");
  root.option("--output <format>", "Output format (json, yaml, csv, table, text)");
  root.option("--debug", "Enable debug output");

  const plex = new Command("plex").description("Plex Media Server operations");
  plex.addCommand(plexAuthCommand);
  root.addCommand(plex);
  return root;
}

function findLeaf(name: string): Command {
  const leaf = plexAuthCommand.commands.find((candidate) => candidate.name() === name);
  if (!leaf) {
    throw new Error(`Expected command ${name} beneath plex auth`);
  }
  return leaf;
}

function optionFlags(command: Command): string[] {
  return command.options.map((option) => option.flags);
}

/**
 * Captures what `--help` actually prints.
 *
 * `helpInformation()` omits `addHelpText` sections, so it cannot see the
 * provisional-enrollment footer; `outputHelp()` is the real rendering path.
 */
function renderedHelp(command: Command): string {
  const chunks: string[] = [];
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as unknown as typeof process.stdout.write);
  try {
    command.outputHelp();
  } finally {
    writeSpy.mockRestore();
  }
  return chunks.join("");
}

describe("plex auth commands", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as unknown as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    process.exitCode = undefined;
  });

  it("registers the four auth leaves with their reference-only options", () => {
    expect(plexAuthCommand.commands.map((command) => command.name())).toEqual([
      "login",
      "status",
      "refresh",
      "logout",
    ]);

    expect(optionFlags(findLeaf("login"))).toEqual([
      "--plex-url <url>",
      "--device-name <name>",
      "--timeout <seconds>",
      "-y, --yes",
    ]);
    expect(optionFlags(findLeaf("status"))).toEqual(["--plex-url <url>"]);
    expect(optionFlags(findLeaf("refresh"))).toEqual([
      "--plex-url <url>",
      "--timeout <seconds>",
      "--force",
    ]);
    expect(optionFlags(findLeaf("logout"))).toEqual(["--plex-url <url>", "-y, --yes"]);

    // No secret-valued flag may ever appear on this group.
    const everyFlag = plexAuthCommand.commands.flatMap(optionFlags).join(" ");
    expect(everyFlag).not.toContain("--plex-token");
    expect(everyFlag).not.toContain("--plex-jwt");

    expect(renderedHelp(findLeaf("login"))).toContain("PLEX_AUTH_INVALID_RESPONSE");
    // Verbatim from the canonical completion table, so help and completions agree.
    expect(
      findLeaf("refresh").options.find((option) => option.long === "--force")?.description,
    ).toBe("Rotate now even if the credential is fresh (does not bypass Plex rate limits)");
  });

  it("registers no argParser on any auth option", () => {
    for (const leaf of plexAuthCommand.commands) {
      for (const option of leaf.options) {
        expect(option.parseArg).toBeUndefined();
      }
    }
  });

  it("routes invalid option values through the failure envelope, never process.exit", async () => {
    const timeoutFailure = new TypeError("--timeout must be a whole number of seconds");
    mockAuthActions.executePlexAuthLogin.mockRejectedValueOnce(timeoutFailure);

    await mountAuthCommand().parseAsync(
      ["--output", "json", "plex", "auth", "login", "--timeout", "abc"],
      { from: "user" },
    );

    // The raw string reached the action untouched: nothing parsed or rejected it earlier.
    expect(mockAuthActions.executePlexAuthLogin).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: "abc", format: "json" }),
    );
    expect(mockAuthActions.buildPlexAuthFailureEnvelope).toHaveBeenCalledWith(
      "login",
      timeoutFailure,
    );
    expect(mockFormatters.formatOutput).toHaveBeenCalledWith("json", {
      command: "plex-auth-login",
      error: expect.objectContaining({ code: "PLEX_AUTH_ARGUMENT_INVALID" }),
    });
    expect(process.exitCode).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();

    process.exitCode = undefined;

    const originFailure = new Error("A Plex server URL is required");
    mockAuthActions.executePlexAuthLogout.mockRejectedValueOnce(originFailure);

    await mountAuthCommand().parseAsync(
      ["--output", "json", "plex", "auth", "logout", "--plex-url", ""],
      { from: "user" },
    );

    // An unset CI variable expands to "" — it must fail through the action, not Commander.
    expect(mockAuthActions.executePlexAuthLogout).toHaveBeenCalledWith(
      expect.objectContaining({ plexUrl: "", format: "json" }),
    );
    expect(mockAuthActions.buildPlexAuthFailureEnvelope).toHaveBeenCalledWith(
      "logout",
      originFailure,
    );
    expect(process.exitCode).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
