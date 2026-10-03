import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const mockResolveOptionalScanAdapter = vi.hoisted(() => vi.fn());
const mockScanTrigger = vi.hoisted(() => vi.fn());

vi.mock("../lib/adapters/action-helpers.js", () => ({
  resolveOptionalScanAdapter: mockResolveOptionalScanAdapter,
}));

vi.mock("../lib/logger.js", () => ({
  logInfo: vi.fn(),
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logSuccess: vi.fn(),
  formatDryRun: vi.fn((message: string) => `[DRY-RUN] ${message}`),
  isJsonMode: vi.fn(() => false),
}));

vi.mock("../lib/progress.js", () => ({
  withSpinner: vi.fn(async (_message: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("../lib/history.js", () => ({
  createHistorySession: vi.fn(),
  isHistoryEnabled: vi.fn(() => false),
}));

import type { DeleteOptions } from "../types/index.js";
import { executeFilterDeleteWithFileInput } from "./delete-filter.js";

describe("executeFilterDeleteWithFileInput adapter scan integration", () => {
  let tempDir: string;
  let sourceDir: string;
  let destinationDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();

    tempDir = await mkdtemp(path.join(tmpdir(), "rfmedia-delete-filter-test-"));
    sourceDir = path.join(tempDir, "source", "Artist");
    destinationDir = path.join(tempDir, "destination");

    await mkdir(sourceDir, { recursive: true });
    await mkdir(path.join(sourceDir, "Album"), { recursive: true });

    const likedSongsDir = path.join(destinationDir, "Artist", "liked-songs");
    await mkdir(likedSongsDir, { recursive: true });
    await writeFile(path.join(likedSongsDir, "track.mp3"), "dummy");

    mockScanTrigger.mockResolvedValue({
      success: true,
      message: "scan queued",
    });

    mockResolveOptionalScanAdapter.mockReturnValue({
      adapter: {
        capabilities: { scan: true },
        scan: { trigger: mockScanTrigger },
      },
      scanPerSource: false,
      libraryName: "Music",
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function createOptions(overrides: Partial<DeleteOptions> = {}): DeleteOptions {
    return {
      mode: {
        type: "filter",
        rating: {
          outputFolder: "liked-songs",
          preserveStructure: false,
        },
      },
      albumOnly: false,
      force: true,
      dryRun: false,
      workers: 1,
      useTrash: false,
      keepTracking: true,
      ...overrides,
    };
  }

  it("triggers adapter scan when deletions were made", async () => {
    const result = await executeFilterDeleteWithFileInput(
      sourceDir,
      destinationDir,
      createOptions(),
    );

    expect(result.deleted).toBe(1);
    expect(mockResolveOptionalScanAdapter).toHaveBeenCalledTimes(1);
    expect(mockScanTrigger).toHaveBeenCalledTimes(1);
  });

  it("does not trigger scan when optional adapter is unavailable", async () => {
    mockResolveOptionalScanAdapter.mockReturnValue({
      adapter: undefined,
      scanPerSource: false,
      libraryName: "Music",
    });

    const result = await executeFilterDeleteWithFileInput(
      sourceDir,
      destinationDir,
      createOptions(),
    );

    expect(result.deleted).toBe(1);
    expect(mockScanTrigger).not.toHaveBeenCalled();
  });
});
