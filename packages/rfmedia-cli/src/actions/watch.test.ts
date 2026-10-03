import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecuteAlbumCopy = vi.hoisted(() => vi.fn());
const mockExecuteFilterCopy = vi.hoisted(() => vi.fn());
const mockResolveOptionalScanAdapter = vi.hoisted(() => vi.fn());
const mockScanTriggerSource = vi.hoisted(() => vi.fn());

vi.mock("./copy-album.js", () => ({
  executeAlbumCopy: mockExecuteAlbumCopy,
}));

vi.mock("./copy-filter.js", () => ({
  executeFilterCopy: mockExecuteFilterCopy,
}));

vi.mock("../lib/adapters/action-helpers.js", () => ({
  resolveOptionalScanAdapter: mockResolveOptionalScanAdapter,
}));

vi.mock("../lib/logger.js", () => ({
  logDebug: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logSuccess: vi.fn(),
  logWarn: vi.fn(),
}));

import type { WatchOptions } from "../types/index.js";
import { processChange } from "./watch.js";

function buildAlbumOptions(overrides: Partial<WatchOptions> = {}): WatchOptions {
  return {
    source: "/music/source",
    destination: "/music/destination",
    mode: "album",
    range: { start: 1, end: 1, padWidth: 3 },
    plexScan: true,
    ...overrides,
  };
}

describe("processChange scan integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockExecuteAlbumCopy.mockResolvedValue({
      source: "/music/source/Artist",
      created: 1,
      skipped: 0,
      filtered: 0,
      failed: [],
    });

    mockExecuteFilterCopy.mockResolvedValue({
      source: "/music/source/Artist",
      created: 1,
      skipped: 0,
      filtered: 0,
      failed: [],
    });

    mockScanTriggerSource.mockResolvedValue({
      success: true,
      message: "scan queued",
    });

    mockResolveOptionalScanAdapter.mockReturnValue({
      adapter: {
        capabilities: { scan: true },
        scan: {
          triggerSource: mockScanTriggerSource,
        },
      },
      scanPerSource: false,
      libraryName: "Music",
    });
  });

  it("triggers adapter source scan after successful copy", async () => {
    const options = buildAlbumOptions();

    const result = await processChange(
      "artist",
      "/music/source/Artist",
      "/music/destination",
      options,
    );

    expect(result.created).toBe(1);
    expect(mockResolveOptionalScanAdapter).toHaveBeenCalledWith({ plexScan: true });
    expect(mockScanTriggerSource).toHaveBeenCalledWith("/music/destination/Artist");
  });

  it("skips scan integration when plexScan is explicitly disabled", async () => {
    const options = buildAlbumOptions({ plexScan: false });

    const result = await processChange(
      "artist",
      "/music/source/Artist",
      "/music/destination",
      options,
    );

    expect(result.created).toBe(1);
    expect(mockResolveOptionalScanAdapter).not.toHaveBeenCalled();
    expect(mockScanTriggerSource).not.toHaveBeenCalled();
  });

  it("does not trigger scan when copy result has no created files", async () => {
    mockExecuteAlbumCopy.mockResolvedValue({
      source: "/music/source/Artist",
      created: 0,
      skipped: 1,
      filtered: 0,
      failed: [],
    });

    const options = buildAlbumOptions();

    const result = await processChange(
      "artist",
      "/music/source/Artist",
      "/music/destination",
      options,
    );

    expect(result.created).toBe(0);
    expect(mockScanTriggerSource).not.toHaveBeenCalled();
  });
});
