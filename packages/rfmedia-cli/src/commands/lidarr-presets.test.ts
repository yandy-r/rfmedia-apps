import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BUILTIN_LIDARR_PRESET_PACKS } from "../lib/lidarr/profile-presets.js";
import {
  LIDARR_PRESET_APPLY_VERSION,
  LIDARR_PRESET_DIFF_VERSION,
  LIDARR_PRESET_LIST_VERSION,
  LIDARR_PRESET_SHOW_VERSION,
  type LidarrPresetApplyResult,
  type LidarrPresetDiffResult,
} from "../types/lidarr-presets.js";

const mockFormatOutput = vi.hoisted(() => vi.fn());

vi.mock("../lib/formatters/index.js", () => ({
  formatOutput: mockFormatOutput,
}));

import { LIDARR_PRESET_CSV_COLUMNS, createLidarrPresetsCommand } from "./lidarr-presets.js";

const pack = BUILTIN_LIDARR_PRESET_PACKS[0]!;
const identity = Object.freeze({
  source: pack.source,
  ref: pack.ref,
  id: pack.id,
  version: pack.version,
  digest: pack.digest,
});

function makeReview(hasChanges: boolean): LidarrPresetDiffResult {
  const resources = hasChanges
    ? [
        Object.freeze({
          key: "naming:1" as const,
          resource: "naming" as const,
          name: "Naming",
          dependencies: Object.freeze([]),
          impact: Object.freeze({ kind: "naming" as const, renamesExistingFiles: false as const }),
          action: "update" as const,
          liveId: 1,
          before: Object.freeze({ renameTracks: false }),
          after: Object.freeze({ renameTracks: true }),
          fieldChanges: Object.freeze([
            Object.freeze({
              path: "renameTracks",
              before: false,
              after: true,
            }),
          ]),
        }),
      ]
    : [
        Object.freeze({
          key: "naming:1" as const,
          resource: "naming" as const,
          name: "Naming",
          dependencies: Object.freeze([]),
          impact: Object.freeze({ kind: "naming" as const, renamesExistingFiles: false as const }),
          action: "unchanged" as const,
          liveId: 1,
          before: Object.freeze({ renameTracks: true }),
          after: Object.freeze({ renameTracks: true }),
          fieldChanges: Object.freeze([]),
        }),
      ];
  return Object.freeze({
    schemaVersion: LIDARR_PRESET_DIFF_VERSION,
    pack: identity,
    targetOrigin: "https://lidarr.example.test",
    assumptions: Object.freeze(["The live schema is compatible."]),
    consequences: Object.freeze(["Future imports use the managed naming policy."]),
    observations: Object.freeze(["Observed one naming policy."]),
    warnings: Object.freeze([]),
    hasChanges,
    summary: Object.freeze({
      total: 1,
      create: 0,
      update: hasChanges ? 1 : 0,
      unchanged: hasChanges ? 0 : 1,
      retained: 0,
    }),
    resources: Object.freeze(resources),
    namingExamples: Object.freeze({
      singleTrackExample: "Album/Artist - 01 - Track",
      multiDiscTrackExample: "Album/Disc 01/Artist - 01 - Track",
      artistFolderExample: "Artist",
      albumFolderExample: "Album",
    }),
    execution: Object.freeze([]),
  });
}

function makeApply(
  review: LidarrPresetDiffResult,
  status: LidarrPresetApplyResult["status"],
): LidarrPresetApplyResult {
  const failed = status === "partial" || status === "failed";
  return Object.freeze({
    schemaVersion: LIDARR_PRESET_APPLY_VERSION,
    dryRun: status === "checked",
    status,
    review,
    summary: Object.freeze({
      total: failed ? 1 : 0,
      succeeded: 0,
      satisfied: 0,
      failed: failed ? 1 : 0,
      uncertain: 0,
      notAttempted: 0,
    }),
    outcomes: Object.freeze(
      failed
        ? [
            Object.freeze({
              key: "naming:1" as const,
              resource: "naming" as const,
              name: "Naming",
              outcome: "failed" as const,
              attempted: false as const,
              dispatchState: "not-dispatched" as const,
              verificationState: "not-started" as const,
              error: Object.freeze({
                code: "LIDARR_PRESET_STALE",
                phase: "pre-dispatch",
                resourcePath: "naming:1",
                retryable: false,
                nextAction: "Run diff again.",
              }),
            }),
          ]
        : [],
    ),
    execution: Object.freeze([]),
  });
}

function createHarness(
  options: {
    format?: "text" | "json" | "yaml" | "csv";
    interactive?: boolean;
    approval?: boolean;
  } = {},
) {
  const review = makeReview(true);
  const actions = {
    executeLidarrPresetList: vi.fn(async () =>
      Object.freeze({
        schemaVersion: LIDARR_PRESET_LIST_VERSION,
        packs: Object.freeze([pack]),
      }),
    ),
    executeLidarrPresetShow: vi.fn(async () =>
      Object.freeze({ schemaVersion: LIDARR_PRESET_SHOW_VERSION, pack }),
    ),
    executeLidarrPresetDiff: vi.fn(async () => review),
    executeLidarrPresetApply: vi.fn(
      async (actionOptions: {
        readonly dryRun?: boolean;
        readonly confirm: (value: LidarrPresetDiffResult) => Promise<boolean>;
      }) => {
        if (actionOptions.dryRun === true) return makeApply(review, "checked");
        const approved = await actionOptions.confirm(review);
        return makeApply(review, approved ? "completed" : "declined");
      },
    ),
  };
  const loadActions = vi.fn(async () => actions);
  const reportLidarrFailure = vi.fn(async () => {
    process.exitCode = 1;
  });
  const confirm = vi.fn(async () => options.approval ?? false);
  const command = new Command("root");
  command.exitOverride();
  command.configureOutput({ writeErr: () => {} });
  command.addCommand(
    createLidarrPresetsCommand({
      resolveFormat: () => options.format ?? "text",
      reportLidarrFailure,
      confirm,
      isInteractive: () => options.interactive ?? true,
      loadActions,
    }),
  );
  const overrideExits = (current: Command): void => {
    current.exitOverride();
    current.configureOutput({ writeErr: () => {} });
    current.commands.forEach(overrideExits);
  };
  overrideExits(command);
  return { command, actions, loadActions, reportLidarrFailure, confirm, review };
}

async function run(command: Command, args: readonly string[]): Promise<void> {
  await command.parseAsync(["node", "rfmedia", "presets", ...args], { from: "node" });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("createLidarrPresetsCommand", () => {
  it("registers the exact four-leaf hierarchy", () => {
    const { command } = createHarness();
    const presets = command.commands.find((child) => child.name() === "presets");

    expect(presets?.commands.map((child) => child.name())).toEqual([
      "list",
      "show",
      "diff",
      "apply",
    ]);
  });

  it("keeps list and show on their offline action paths", async () => {
    const harness = createHarness();

    await run(harness.command, ["list"]);
    await run(harness.command, ["show", "builtin:balanced"]);

    expect(harness.actions.executeLidarrPresetList).toHaveBeenCalledOnce();
    expect(harness.actions.executeLidarrPresetShow).toHaveBeenCalledWith({
      packRef: "builtin:balanced",
    });
    expect(harness.actions.executeLidarrPresetDiff).not.toHaveBeenCalled();
    expect(harness.actions.executeLidarrPresetApply).not.toHaveBeenCalled();
  });

  it("validates a pack reference before loading actions", async () => {
    const harness = createHarness();

    await expect(run(harness.command, ["show", "Builtin:balanced"])).rejects.toMatchObject({
      code: "commander.invalidArgument",
    });
    expect(harness.loadActions).not.toHaveBeenCalled();
  });

  it("forwards diff connection options and renders changed and no-op reviews successfully", async () => {
    const harness = createHarness();

    await run(harness.command, [
      "diff",
      "balanced",
      "--lidarr-url",
      "https://lidarr.example.test",
      "--lidarr-api-key",
      "secret",
      "--verbose",
    ]);
    harness.actions.executeLidarrPresetDiff.mockResolvedValueOnce(makeReview(false));
    await run(harness.command, ["diff", "balanced"]);

    expect(harness.actions.executeLidarrPresetDiff).toHaveBeenNthCalledWith(1, {
      packRef: "balanced",
      lidarrUrl: "https://lidarr.example.test",
      lidarrApiKey: "secret",
    });
    expect(process.exitCode).toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("No changes were made"));
  });

  it("renders the full changing review once and defaults interactive approval to no", async () => {
    const harness = createHarness({ approval: false });

    await run(harness.command, ["apply", "balanced"]);

    expect(harness.confirm).toHaveBeenCalledOnce();
    expect(harness.actions.executeLidarrPresetApply).toHaveBeenCalledWith(
      expect.objectContaining({ packRef: "balanced", dryRun: false }),
    );
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Preset apply cancelled"));
    expect(process.exitCode).toBeUndefined();
  });

  it("requires --yes for machine or non-interactive mutation but gives dry-run precedence", async () => {
    const machine = createHarness({ format: "json" });
    await run(machine.command, ["apply", "balanced"]);

    expect(machine.confirm).not.toHaveBeenCalled();
    expect(machine.reportLidarrFailure).toHaveBeenCalledWith(
      "presets-apply",
      expect.objectContaining({
        message: expect.stringContaining("--yes is required"),
      }),
      expect.objectContaining({ format: "json" }),
    );

    process.exitCode = undefined;
    const dryRun = createHarness({ format: "json", interactive: false });
    await run(dryRun.command, ["apply", "balanced", "--dry-run"]);

    expect(dryRun.reportLidarrFailure).not.toHaveBeenCalled();
    expect(dryRun.confirm).not.toHaveBeenCalled();
    expect(mockFormatOutput).toHaveBeenCalledWith(
      "json",
      expect.objectContaining({ schemaVersion: LIDARR_PRESET_APPLY_VERSION, dryRun: true }),
      undefined,
    );
  });

  it("keeps machine output off stderr and uses the fixed CSV columns", async () => {
    const json = createHarness({ format: "json" });
    await run(json.command, ["diff", "balanced"]);
    expect(console.error).not.toHaveBeenCalled();
    expect(mockFormatOutput).toHaveBeenCalledWith("json", json.review, undefined);

    vi.mocked(console.error).mockClear();
    mockFormatOutput.mockClear();
    const csv = createHarness({ format: "csv" });
    await run(csv.command, ["diff", "balanced"]);
    expect(console.error).not.toHaveBeenCalled();
    expect(mockFormatOutput).toHaveBeenCalledWith(
      "csv",
      expect.arrayContaining([expect.objectContaining({ rowType: "summary" })]),
      { columns: [...LIDARR_PRESET_CSV_COLUMNS] },
    );
  });

  it("projects safe recovery details for failed CSV outcomes", async () => {
    const harness = createHarness({ format: "csv", approval: true });
    harness.actions.executeLidarrPresetApply.mockImplementationOnce(
      async (actionOptions: {
        readonly confirm: (value: LidarrPresetDiffResult) => Promise<boolean>;
      }) => {
        await actionOptions.confirm(harness.review);
        return Object.freeze({
          ...makeApply(harness.review, "partial"),
          error: Object.freeze({
            code: "LIDARR_PRESET_JOURNAL_WRITE_FAILED",
            phase: "finalize",
            resourcePath: "/tmp/preset.json",
            retryable: true,
            nextAction: "Run diff again.",
          }),
        });
      },
    );

    await run(harness.command, ["apply", "balanced", "--yes"]);

    expect(mockFormatOutput).toHaveBeenCalledWith(
      "csv",
      expect.arrayContaining([
        expect.objectContaining({
          rowType: "outcome",
          "outcome.status": "failed",
          "outcome.error.code": "LIDARR_PRESET_STALE",
          "outcome.error.phase": "pre-dispatch",
          "outcome.error.resourcePath": "naming:1",
          "outcome.error.retryable": false,
          "outcome.error.nextAction": "Run diff again.",
        }),
        expect.objectContaining({
          rowType: "error",
          "outcome.error.code": "LIDARR_PRESET_JOURNAL_WRITE_FAILED",
          "outcome.error.phase": "finalize",
          "outcome.error.resourcePath": "/tmp/preset.json",
          "outcome.error.retryable": true,
          "outcome.error.nextAction": "Run diff again.",
        }),
      ]),
      { columns: [...LIDARR_PRESET_CSV_COLUMNS] },
    );
  });

  it("sets exit status for partial apply and passes API keys only as redaction values", async () => {
    const harness = createHarness({ approval: true });
    harness.actions.executeLidarrPresetApply.mockImplementationOnce(
      async (actionOptions: {
        readonly confirm: (value: LidarrPresetDiffResult) => Promise<boolean>;
      }) => {
        await actionOptions.confirm(harness.review);
        return makeApply(harness.review, "partial");
      },
    );

    await run(harness.command, ["apply", "balanced", "--yes", "--lidarr-api-key", "top-secret"]);

    expect(process.exitCode).toBe(1);
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("top-secret"));

    process.exitCode = undefined;
    harness.actions.executeLidarrPresetDiff.mockRejectedValueOnce(
      new Error("request failed with top-secret"),
    );
    await run(harness.command, ["diff", "balanced", "--lidarr-api-key", "top-secret"]);
    expect(harness.reportLidarrFailure).toHaveBeenCalledWith(
      "presets-diff",
      expect.any(Error),
      expect.objectContaining({ sensitiveValues: ["top-secret"] }),
    );
  });
});
