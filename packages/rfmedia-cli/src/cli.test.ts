import { homedir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const commandMocks = vi.hoisted(() => ({
  executeAlbumVerifyWithFileInput: vi.fn(),
  executeFilterVerifyWithFileInput: vi.fn(),
  loadConfig: vi.fn(),
  resolveUndoDatabasePath: vi.fn(),
}));

vi.mock("./actions/verify-album.js", () => ({
  executeAlbumVerifyWithFileInput: commandMocks.executeAlbumVerifyWithFileInput,
}));

vi.mock("./actions/verify-filter.js", () => ({
  executeFilterVerifyWithFileInput: commandMocks.executeFilterVerifyWithFileInput,
}));

vi.mock("./lib/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/config.js")>();
  commandMocks.loadConfig.mockImplementation(actual.loadConfig);
  commandMocks.resolveUndoDatabasePath.mockImplementation(actual.resolveUndoDatabasePath);
  return {
    ...actual,
    loadConfig: commandMocks.loadConfig,
    resolveUndoDatabasePath: commandMocks.resolveUndoDatabasePath,
  };
});

import {
  isCredentialFreeOfflineReconcile,
  isStrictPolicyConfigCommand,
  parseOutputFormatArg,
  program,
} from "./cli.js";
import {
  buildVerifyOptions,
  createVerifyOutput,
  projectVerifyOutput,
  verifyCommand,
} from "./commands/verify.js";
import { getDefaultDatabasePath } from "./lib/db.js";
import { InvalidOutputFormatError } from "./lib/errors.js";
import { setLoadedConfig } from "./lib/loaded-config.js";
import { addExtraFile, addVerifyOutcome, createVerifyResult } from "./lib/tiered-verification.js";
import type { VerifyCommandResult } from "./types/results.js";

const range = { start: 1, end: 1, padWidth: 3 };

function verifyResult(overrides: Partial<VerifyCommandResult> = {}): VerifyCommandResult {
  return {
    source: "/music",
    tier: "deep",
    verified: 6,
    missing: 1,
    sizeMismatch: 2,
    metadataMismatch: 3,
    hashMismatch: 4,
    contentMismatch: 5,
    unverifiable: 6,
    notApplicable: 7,
    unstable: 8,
    extra: 9,
    expectedTotal: 35,
    issues: [
      {
        path: "Artist/Album/track.flac",
        status: "hash-mismatch",
        reason: "fingerprint-invalid",
        evidence: ["hash"],
      },
    ],
    failed: [{ path: "Artist/Album/read.flac", message: "read failed", code: "EIO" }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setLoadedConfig({});
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  setLoadedConfig({});
  process.exitCode = undefined;
});

describe("offline reconciliation startup", () => {
  it("classifies only lidarr reconcile --offline as credential-free", () => {
    const root = new Command("rfmedia");
    const lidarr = new Command("lidarr");
    const reconcile = new Command("reconcile").option("--offline");
    root.addCommand(lidarr);
    lidarr.addCommand(reconcile);

    reconcile.setOptionValue("offline", true);
    expect(isCredentialFreeOfflineReconcile(reconcile)).toBe(true);

    reconcile.setOptionValue("offline", false);
    expect(isCredentialFreeOfflineReconcile(reconcile)).toBe(false);

    const unrelated = new Command("reconcile").option("--offline");
    unrelated.setOptionValue("offline", true);
    root.addCommand(unrelated);
    expect(isCredentialFreeOfflineReconcile(unrelated)).toBe(false);
  });
});

describe("strict policy config startup", () => {
  function commandPath(...names: readonly string[]): Command {
    const root = new Command("rfmedia");
    let parent = root;
    for (const name of names) {
      const child = new Command(name);
      parent.addCommand(child);
      parent = child;
    }
    return parent;
  }

  it.each([
    ["lidarr policy evaluate", ["lidarr", "policy", "evaluate"]],
    ["lidarr policy plan", ["lidarr", "policy", "plan"]],
    ["lidarr sync-ratings", ["lidarr", "sync-ratings"]],
  ] as const)("classifies %s as strict", (_label, names) => {
    expect(isStrictPolicyConfigCommand(commandPath(...names))).toBe(true);
  });

  it.each([
    ["lidarr plan", ["lidarr", "plan"]],
    ["lidarr reconcile", ["lidarr", "reconcile"]],
    ["lidarr policy inspect", ["lidarr", "policy", "inspect"]],
    ["plex policy evaluate", ["plex", "policy", "evaluate"]],
    ["top-level sync-ratings", ["sync-ratings"]],
  ] as const)("keeps %s permissive", (_label, names) => {
    expect(isStrictPolicyConfigCommand(commandPath(...names))).toBe(false);
  });

  it.each([
    ["wrapper lidarr policy evaluate", ["lidarr", "policy", "evaluate"]],
    ["wrapper lidarr sync-ratings", ["lidarr", "sync-ratings"]],
  ] as const)("rejects the strict-looking suffix under %s", (_label, names) => {
    const wrapper = new Command("wrapper");
    let parent = wrapper;
    for (const name of names) {
      const child = new Command(name);
      parent.addCommand(child);
      parent = child;
    }

    expect(isStrictPolicyConfigCommand(parent)).toBe(false);
  });

  it("does not change the credential-free offline reconcile classification", () => {
    const reconcile = commandPath("lidarr", "reconcile").option("--offline");
    reconcile.setOptionValue("offline", true);

    expect(isCredentialFreeOfflineReconcile(reconcile)).toBe(true);
    expect(isStrictPolicyConfigCommand(reconcile)).toBe(false);
  });

  it("passes authoritative loading to the single root pre-action config load", async () => {
    const stopBeforeAction = new Error("stop after config load");
    commandMocks.loadConfig.mockRejectedValueOnce(stopBeforeAction);

    await expect(
      program.parseAsync(["node", "rfmedia", "lidarr", "policy", "evaluate"]),
    ).rejects.toBe(stopBeforeAction);
    expect(commandMocks.loadConfig).toHaveBeenCalledWith({
      resolveSecrets: true,
      failOnInvalid: true,
    });
    expect(commandMocks.loadConfig).toHaveBeenCalledTimes(1);
  });
});

describe("parseOutputFormatArg", () => {
  it("returns valid output formats", () => {
    expect(parseOutputFormatArg("json")).toBe("json");
    expect(parseOutputFormatArg("yaml")).toBe("yaml");
    expect(parseOutputFormatArg("text")).toBe("text");
  });

  it("throws InvalidOutputFormatError for unsupported output formats", () => {
    expect(() => parseOutputFormatArg("xml")).toThrowError(InvalidOutputFormatError);
  });

  it("wires InvalidOutputFormatError through global --output parser", async () => {
    program.exitOverride();
    await expect(
      program.parseAsync(["node", "rfmedia", "--output", "xml", "completion"], { from: "node" }),
    ).rejects.toBeInstanceOf(InvalidOutputFormatError);
  });
});

describe("verify CLI contract", () => {
  it.each([
    [{}, "default"],
    [{ quick: true }, "quick"],
    [{ deep: true }, "deep"],
  ] as const)("maps tier flags %# to %s", (raw, tier) => {
    const resolveTrackingDatabase = vi.fn(() => "/configured/tracking.db");

    const options = buildVerifyOptions({ range, ...raw }, false, true, resolveTrackingDatabase);

    expect(options.tier).toBe(tier);
    expect(options.verifySize).toBeUndefined();
    expect(resolveTrackingDatabase).toHaveBeenCalledTimes(tier === "quick" ? 0 : 1);
    expect(options.trackingDatabase).toBe(tier === "quick" ? undefined : "/configured/tracking.db");
  });

  it("keeps --verify-size additive and gives the explicit database path highest precedence", () => {
    const resolveTrackingDatabase = vi.fn(() => "/configured/tracking.db");

    const options = buildVerifyOptions(
      {
        range,
        deep: true,
        trackingDatabase: "/cli/tracking.db",
        verifySize: true,
      },
      false,
      true,
      resolveTrackingDatabase,
    );

    expect(options).toMatchObject({
      tier: "deep",
      trackingDatabase: "/cli/tracking.db",
      verifySize: true,
    });
    expect(resolveTrackingDatabase).not.toHaveBeenCalled();
  });

  it("uses configured undo/tracking compatibility and then the existing default path", () => {
    setLoadedConfig({
      undo: { database: "~/undo.db" },
      tracking: { database: "/configured/tracking.db" },
    });
    expect(buildVerifyOptions({ range }, false, true).trackingDatabase).toBe(
      join(homedir(), "undo.db"),
    );

    setLoadedConfig({ tracking: { database: "/configured/tracking.db" } });
    expect(buildVerifyOptions({ range }, false, true).trackingDatabase).toBe(
      "/configured/tracking.db",
    );

    setLoadedConfig({});
    expect(buildVerifyOptions({ range }, false, true).trackingDatabase).toBe(
      getDefaultDatabasePath(),
    );
  });

  it("bypasses all database-path resolution in quick mode, including an explicit path", () => {
    const resolveTrackingDatabase = vi.fn(() => {
      throw new Error("must not resolve");
    });

    expect(
      buildVerifyOptions(
        { range, quick: true, trackingDatabase: "/ignored/tracking.db" },
        false,
        true,
        resolveTrackingDatabase,
      ).trackingDatabase,
    ).toBeUndefined();
    expect(resolveTrackingDatabase).not.toHaveBeenCalled();
  });

  it.each(["json", "yaml"] as const)(
    "projects complete nested %s output without raw digests",
    (format) => {
      const result = Object.assign(verifyResult(), {
        expectedDigest: "a".repeat(64),
        actualDigest: "b".repeat(64),
      });
      const output = projectVerifyOutput(format, createVerifyOutput("album", "/dest", result));

      expect(output).toMatchObject({
        command: "verify",
        mode: "album",
        tier: "deep",
        status: "incomplete",
        result: {
          verified: 6,
          missing: 1,
          sizeMismatch: 2,
          metadataMismatch: 3,
          hashMismatch: 4,
          contentMismatch: 5,
          unverifiable: 6,
          notApplicable: 7,
          unstable: 8,
          extra: 9,
          expectedTotal: 35,
          issues: [expect.objectContaining({ status: "hash-mismatch", evidence: ["hash"] })],
        },
      });
      expect(JSON.stringify(output)).not.toContain("a".repeat(64));
      expect(JSON.stringify(output)).not.toContain("b".repeat(64));
    },
  );

  it.each(["table", "csv"] as const)("uses a flat, issue-bearing %s projection", (format) => {
    const output = projectVerifyOutput(
      format,
      createVerifyOutput("filter", "/dest", verifyResult()),
    );

    expect(output).toMatchObject({
      command: "verify",
      mode: "filter",
      tier: "deep",
      status: "incomplete",
      verified: 6,
      missing: 1,
      metadataMismatch: 3,
      hashMismatch: 4,
      contentMismatch: 5,
      unverifiable: 6,
      notApplicable: 7,
      unstable: 8,
      extra: 9,
      issues: [expect.objectContaining({ path: "Artist/Album/track.flac" })],
    });
    expect(output).not.toHaveProperty("result");
  });

  it.each(["json", "csv"] as const)(
    "projects explicit extra issues through %s output without counting them as expected",
    (format) => {
      const result = createVerifyResult("/music", "default");
      addVerifyOutcome(result, { path: "expected.flac", status: "present" });
      addExtraFile(result, "extra.flac");

      const output = projectVerifyOutput(format, createVerifyOutput("filter", "/dest", result));

      expect(output).toMatchObject(
        format === "json"
          ? {
              result: {
                verified: 1,
                extra: 1,
                expectedTotal: 1,
                issues: [{ path: "extra.flac", status: "extra" }],
              },
            }
          : {
              verified: 1,
              extra: 1,
              expectedTotal: 1,
              issues: [{ path: "extra.flac", status: "extra" }],
            },
      );
    },
  );

  it("uses the shared unresolved predicate for status, including extras", () => {
    expect(createVerifyOutput("album", "/dest", verifyResult({ extra: 1 })).status).toBe(
      "incomplete",
    );
    expect(
      createVerifyOutput(
        "album",
        "/dest",
        verifyResult({
          verified: 1,
          missing: 0,
          sizeMismatch: 0,
          metadataMismatch: 0,
          hashMismatch: 0,
          contentMismatch: 0,
          unverifiable: 0,
          notApplicable: 0,
          unstable: 0,
          extra: 0,
          expectedTotal: 1,
          issues: [],
          failed: [],
        }),
      ).status,
    ).toBe("complete");
  });

  it("propagates the effective tier, database path, and additive size precheck to the action", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    commandMocks.executeAlbumVerifyWithFileInput.mockResolvedValue(
      verifyResult({
        tier: "deep",
        verified: 1,
        missing: 0,
        sizeMismatch: 0,
        metadataMismatch: 0,
        hashMismatch: 0,
        contentMismatch: 0,
        unverifiable: 0,
        notApplicable: 0,
        unstable: 0,
        extra: 0,
        expectedTotal: 1,
        issues: [],
        failed: [],
      }),
    );

    await verifyCommand.parseAsync(
      [
        "/music/Artist",
        "/backup",
        "--range",
        "001-001",
        "--deep",
        "--tracking-database",
        "/cli/tracking.db",
        "--verify-size",
      ],
      { from: "user" },
    );

    expect(commandMocks.executeAlbumVerifyWithFileInput).toHaveBeenCalledWith(
      undefined,
      "/backup",
      expect.objectContaining({
        tier: "deep",
        trackingDatabase: "/cli/tracking.db",
        verifySize: true,
      }),
    );
    expect(commandMocks.resolveUndoDatabasePath).not.toHaveBeenCalled();
    const humanOutput = consoleError.mock.calls.flat().join("\n");
    expect(humanOutput).toContain(
      "Verification tier: deep (stored SHA-256 plus applicable byte comparison)",
    );
    expect(humanOutput).toContain("metadata-mismatch=0");
    expect(humanOutput).toContain("Tier status: COMPLETE");
    consoleError.mockRestore();
  });

  it("rejects --quick with --deep before option construction or action dispatch", async () => {
    vi.clearAllMocks();
    verifyCommand.exitOverride();

    await expect(
      verifyCommand.parseAsync(
        ["/music/Artist", "/backup", "--range", "001-001", "--quick", "--deep"],
        { from: "user" },
      ),
    ).rejects.toThrow(/cannot be used with option/iu);
    expect(commandMocks.resolveUndoDatabasePath).not.toHaveBeenCalled();
    expect(commandMocks.executeAlbumVerifyWithFileInput).not.toHaveBeenCalled();
    expect(commandMocks.executeFilterVerifyWithFileInput).not.toHaveBeenCalled();
  });
});
