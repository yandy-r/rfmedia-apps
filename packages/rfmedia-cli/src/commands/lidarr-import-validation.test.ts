import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OutputFormat } from "@rfmedia/common";

const mockExecute = vi.hoisted(() => vi.fn());
const mockFormatOutput = vi.hoisted(() => vi.fn());

vi.mock("../actions/lidarr/index.js", () => ({
  executeLidarrValidateImport: mockExecute,
}));
vi.mock("../lib/formatters/index.js", () => ({
  formatOutput: mockFormatOutput,
}));

import { createLidarrImportValidationCommand } from "./lidarr-import-validation.js";

const execution = {
  taskId: "lidarr-validate-import",
  operation: "lidarr validate import",
  lane: "local-only" as const,
  outcome: "succeeded" as const,
  attempts: 1,
};

function result(highestStatus: "ready" | "unmatched" | "ambiguous" | "rejected" = "ready") {
  const finding = {
    path: "/incoming/01.flac",
    status: highestStatus,
    reason: "evidence",
    albumReleaseForeignId: "release-mbid",
    tracks: [],
    rejections: [],
  };
  return {
    execution,
    report: {
      checkedAt: "2026-07-25T12:00:00.000Z",
      folder: "/incoming",
      filterExistingFiles: false,
      replaceExistingFiles: false,
      findings: [finding],
      summary: {
        total: 1,
        ready: highestStatus === "ready" ? 1 : 0,
        unmatched: highestStatus === "unmatched" ? 1 : 0,
        ambiguous: highestStatus === "ambiguous" ? 1 : 0,
        rejected: highestStatus === "rejected" ? 1 : 0,
        highestStatus,
      },
    },
  };
}

function createCommand(format: OutputFormat = "text") {
  return createLidarrImportValidationCommand({
    resolveFormat: () => format,
    parsePositiveInt: (value) => Number.parseInt(value, 10),
    reportLidarrFailure: vi.fn(),
    renderExecutionSummary: vi.fn(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  mockExecute.mockResolvedValue(result());
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("lidarr validate-import command", () => {
  it("forwards the complete probe contract and emits one JSON envelope", async () => {
    const command = createCommand("json");

    await command.parseAsync(
      ["/incoming", "--artist-id", "7", "--filter-existing-files", "--replace-existing-files"],
      { from: "user" },
    );

    expect(mockExecute).toHaveBeenCalledWith({
      folder: "/incoming",
      artistId: 7,
      filterExistingFiles: true,
      replaceExistingFiles: true,
      lidarrUrl: undefined,
      lidarrApiKey: undefined,
    });
    expect(mockFormatOutput).toHaveBeenCalledWith(
      "json",
      { command: "lidarr-validate-import", result: result() },
      undefined,
    );
  });

  it("applies --fail-on only after rendering the diagnostic", async () => {
    mockExecute.mockResolvedValue(result("ambiguous"));
    const command = createCommand("json");

    await command.parseAsync(["/incoming", "--fail-on", "unmatched"], { from: "user" });

    expect(mockFormatOutput).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });

  it("renders stable summary and finding rows for CSV", async () => {
    const command = createCommand("csv");

    await command.parseAsync(["/incoming"], { from: "user" });

    const rows = mockFormatOutput.mock.calls[0]?.[1] as readonly Record<string, unknown>[];
    expect(rows.map((row) => row["rowType"])).toEqual(["summary", "finding"]);
    expect(rows[1]).toMatchObject({
      "finding.path": "/incoming/01.flac",
      "finding.status": "ready",
      "finding.albumReleaseForeignId": "release-mbid",
    });
  });
});
