import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetJobs = vi.hoisted(() => vi.fn());
const mockUpdateJobStatus = vi.hoisted(() => vi.fn());
const mockProcessInParallel = vi.hoisted(() => vi.fn());
const mockExecuteAlbumCopyWithFileInput = vi.hoisted(() => vi.fn());
const mockResolveOptionalScanAdapter = vi.hoisted(() => vi.fn());
const mockScanTrigger = vi.hoisted(() => vi.fn());

vi.mock("../lib/queue.js", () => ({
  addJob: vi.fn(),
  getJobs: mockGetJobs,
  getQueueStats: vi.fn(),
  updateJobStatus: mockUpdateJobStatus,
  removeJob: vi.fn(),
  removeJobsByStatus: vi.fn(),
}));

vi.mock("../lib/db.js", () => ({
  initializeDatabase: vi.fn().mockResolvedValue({}),
}));

vi.mock("../lib/queue-db.js", () => ({
  deserializeDeleteSelectionFromDb: vi.fn().mockReturnValue(null),
  deserializeCopySelectionFromDb: vi.fn().mockReturnValue(null),
}));

vi.mock("../lib/parallel.js", () => ({
  processInParallel: mockProcessInParallel,
}));

vi.mock("../lib/adapters/action-helpers.js", () => ({
  resolveOptionalScanAdapter: mockResolveOptionalScanAdapter,
}));

vi.mock("../lib/signal-handler.js", () => ({
  getGlobalSignal: vi.fn().mockReturnValue({
    aborted: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }),
  registerGlobalCleanup: vi.fn(),
  unregisterGlobalCleanup: vi.fn(),
}));

vi.mock("./copy-album.js", () => ({
  executeAlbumCopyWithFileInput: mockExecuteAlbumCopyWithFileInput,
}));

vi.mock("./copy-filter.js", () => ({
  executeFilterCopyWithFileInput: vi.fn(),
}));

vi.mock("./delete-album.js", () => ({
  executeAlbumDeleteWithFileInput: vi.fn(),
}));

vi.mock("./delete-filter.js", () => ({
  executeFilterDeleteWithFileInput: vi.fn(),
}));

vi.mock("../lib/logger.js", () => ({
  logInfo: vi.fn(),
  logSuccess: vi.fn(),
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  output: vi.fn(),
  outputSuccess: vi.fn(),
}));

vi.mock("../lib/prompt.js", () => ({
  confirm: vi.fn().mockResolvedValue(true),
}));

import type { QueueJob } from "../types/queue.js";
import { executeQueueRun } from "./queue.js";

const pendingJob: QueueJob = {
  id: "job-1",
  jobType: "copy",
  addedAt: new Date().toISOString(),
  source: "/music/source/Artist",
  destination: "/music/destination",
  options: {
    mode: { type: "album", range: { start: 1, end: 1, padWidth: 3 } },
    albumOnly: false,
    hardlink: false,
    force: false,
    workers: 1,
  },
  status: "pending",
};

describe("executeQueueRun adapter scan integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetJobs.mockResolvedValue([pendingJob]);
    mockUpdateJobStatus.mockResolvedValue(undefined);

    mockExecuteAlbumCopyWithFileInput.mockResolvedValue({
      source: "/music/source/Artist",
      created: 2,
      skipped: 0,
      filtered: 0,
      failed: [],
    });

    mockProcessInParallel.mockImplementation(async (items, worker) => {
      const value = await worker(items[0], 0, undefined);
      return [{ success: true, value, index: 0 }];
    });

    mockScanTrigger.mockResolvedValue({ success: true, message: "scan queued" });
    mockResolveOptionalScanAdapter.mockReturnValue({
      adapter: {
        capabilities: { scan: true },
        scan: { trigger: mockScanTrigger },
      },
      scanPerSource: false,
      libraryName: "Music",
    });
  });

  it("triggers adapter scan when queue completes jobs", async () => {
    const result = await executeQueueRun({
      workers: 1,
      continueOnError: true,
      dryRun: false,
      plexScan: true,
    });

    expect(result.completed).toBe(1);
    expect(mockResolveOptionalScanAdapter).toHaveBeenCalledWith({ plexScan: true });
    expect(mockScanTrigger).toHaveBeenCalledTimes(1);
  });

  it("does not trigger adapter scan when queue-level plex scan is disabled", async () => {
    const result = await executeQueueRun({
      workers: 1,
      continueOnError: true,
      dryRun: false,
      plexScan: false,
    });

    expect(result.completed).toBe(1);
    expect(mockResolveOptionalScanAdapter).not.toHaveBeenCalled();
    expect(mockScanTrigger).not.toHaveBeenCalled();
  });
});
