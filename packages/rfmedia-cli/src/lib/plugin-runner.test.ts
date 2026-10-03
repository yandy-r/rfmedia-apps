/**
 * Unit tests for plugin-runner.ts.
 *
 * Tests cover hook execution order by priority, error collection with
 * continueOnError, abort signal handling, and result summarization.
 *
 * IMPORTANT: Uses vi.clearAllMocks() in beforeEach(), NOT vi.resetAllMocks().
 * Using resetAllMocks() would reset mock implementations and break tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies with vi.hoisted() - must be defined before vi.mock() calls
const mockLogger = vi.hoisted(() => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

// Apply mocks BEFORE importing the module under test
vi.mock("./logger.js", () => mockLogger);

// Import after mocks
import {
  runBeforeCopyHooks,
  runAfterCopyHooks,
  runProcessFileHooks,
  runAfterBatchHooks,
  summarizeHookResults,
  type HookResult,
} from "./plugin-runner.js";
import { PluginExecutionError } from "../types/plugins.js";
import type {
  RfmediaPlugin,
  BeforeCopyContext,
  AfterCopyContext,
  ProcessFileContext,
  AfterBatchContext,
  BeforeCopyHook,
  AfterCopyHook,
  ProcessFileHook,
  AfterBatchHook,
} from "../types/plugins.js";
import type { CopyResult } from "../types/results.js";

describe("runBeforeCopyHooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createBeforeCopyContext = (): BeforeCopyContext => ({
    sourcePath: "/source/file.flac",
    destPath: "/dest/file.flac",
    isAudioFile: true,
  });

  it("should execute hooks in priority order (lower first)", async () => {
    const executionOrder: string[] = [];

    const plugins: RfmediaPlugin[] = [
      {
        name: "priority-50",
        version: "1.0.0",
        priority: 50,
        hooks: [
          {
            type: "beforeCopy",
            handler: async () => {
              executionOrder.push("priority-50");
            },
          } as BeforeCopyHook,
        ],
      },
      {
        name: "priority-10",
        version: "1.0.0",
        priority: 10,
        hooks: [
          {
            type: "beforeCopy",
            handler: async () => {
              executionOrder.push("priority-10");
            },
          } as BeforeCopyHook,
        ],
      },
      {
        name: "priority-90",
        version: "1.0.0",
        priority: 90,
        hooks: [
          {
            type: "beforeCopy",
            handler: async () => {
              executionOrder.push("priority-90");
            },
          } as BeforeCopyHook,
        ],
      },
    ];

    await runBeforeCopyHooks(plugins, createBeforeCopyContext());

    expect(executionOrder).toEqual(["priority-10", "priority-50", "priority-90"]);
  });

  it("should use default priority of 50 when not specified", async () => {
    const executionOrder: string[] = [];

    const plugins: RfmediaPlugin[] = [
      {
        name: "no-priority",
        version: "1.0.0",
        // No priority - should default to 50
        hooks: [
          {
            type: "beforeCopy",
            handler: async () => {
              executionOrder.push("no-priority");
            },
          } as BeforeCopyHook,
        ],
      },
      {
        name: "priority-30",
        version: "1.0.0",
        priority: 30,
        hooks: [
          {
            type: "beforeCopy",
            handler: async () => {
              executionOrder.push("priority-30");
            },
          } as BeforeCopyHook,
        ],
      },
    ];

    await runBeforeCopyHooks(plugins, createBeforeCopyContext());

    expect(executionOrder).toEqual(["priority-30", "no-priority"]);
  });

  it("should return results for each executed hook", async () => {
    const plugins: RfmediaPlugin[] = [
      {
        name: "plugin1",
        version: "1.0.0",
        hooks: [
          {
            type: "beforeCopy",
            handler: async () => {},
          } as BeforeCopyHook,
        ],
      },
      {
        name: "plugin2",
        version: "1.0.0",
        hooks: [
          {
            type: "beforeCopy",
            handler: async () => {},
          } as BeforeCopyHook,
        ],
      },
    ];

    const results = await runBeforeCopyHooks(plugins, createBeforeCopyContext());

    expect(results).toHaveLength(2);
    expect(results[0]?.pluginName).toBe("plugin1");
    expect(results[0]?.success).toBe(true);
    expect(results[1]?.pluginName).toBe("plugin2");
    expect(results[1]?.success).toBe(true);
  });

  it("should skip plugins without beforeCopy hooks", async () => {
    const plugins: RfmediaPlugin[] = [
      {
        name: "has-hook",
        version: "1.0.0",
        hooks: [
          {
            type: "beforeCopy",
            handler: async () => {},
          } as BeforeCopyHook,
        ],
      },
      {
        name: "no-hook",
        version: "1.0.0",
        hooks: [
          {
            type: "afterCopy",
            handler: async () => {},
          } as AfterCopyHook,
        ],
      },
      {
        name: "no-hooks-array",
        version: "1.0.0",
      },
    ];

    const results = await runBeforeCopyHooks(plugins, createBeforeCopyContext());

    expect(results).toHaveLength(1);
    expect(results[0]?.pluginName).toBe("has-hook");
  });

  it("should collect errors with continueOnError: true (default)", async () => {
    const plugins: RfmediaPlugin[] = [
      {
        name: "failing-plugin",
        version: "1.0.0",
        hooks: [
          {
            type: "beforeCopy",
            handler: async () => {
              throw new Error("Plugin failed");
            },
          } as BeforeCopyHook,
        ],
      },
      {
        name: "passing-plugin",
        version: "1.0.0",
        hooks: [
          {
            type: "beforeCopy",
            handler: async () => {},
          } as BeforeCopyHook,
        ],
      },
    ];

    const results = await runBeforeCopyHooks(plugins, createBeforeCopyContext());

    expect(results).toHaveLength(2);
    expect(results[0]?.success).toBe(false);
    expect(results[0]?.error).toBeInstanceOf(PluginExecutionError);
    expect(results[1]?.success).toBe(true);
  });

  it("should throw error immediately with continueOnError: false", async () => {
    const plugins: RfmediaPlugin[] = [
      {
        name: "failing-plugin",
        version: "1.0.0",
        priority: 10,
        hooks: [
          {
            type: "beforeCopy",
            handler: async () => {
              throw new Error("Plugin failed");
            },
          } as BeforeCopyHook,
        ],
      },
      {
        name: "should-not-run",
        version: "1.0.0",
        priority: 20,
        hooks: [
          {
            type: "beforeCopy",
            handler: vi.fn(),
          } as BeforeCopyHook,
        ],
      },
    ];

    await expect(
      runBeforeCopyHooks(plugins, createBeforeCopyContext(), { continueOnError: false }),
    ).rejects.toThrow(PluginExecutionError);

    // Second plugin should not have run
    const secondHandler = plugins[1]?.hooks?.[0]?.handler as ReturnType<typeof vi.fn>;
    expect(secondHandler).not.toHaveBeenCalled();
  });

  it("should stop execution when abort signal is triggered", async () => {
    const abortController = new AbortController();
    const executionOrder: string[] = [];

    const plugins: RfmediaPlugin[] = [
      {
        name: "plugin1",
        version: "1.0.0",
        priority: 10,
        hooks: [
          {
            type: "beforeCopy",
            handler: async () => {
              executionOrder.push("plugin1");
              abortController.abort(); // Abort after first plugin
            },
          } as BeforeCopyHook,
        ],
      },
      {
        name: "plugin2",
        version: "1.0.0",
        priority: 20,
        hooks: [
          {
            type: "beforeCopy",
            handler: async () => {
              executionOrder.push("plugin2");
            },
          } as BeforeCopyHook,
        ],
      },
    ];

    await runBeforeCopyHooks(plugins, createBeforeCopyContext(), {
      signal: abortController.signal,
    });

    expect(executionOrder).toEqual(["plugin1"]);
  });

  it("should skip all hooks when signal is already aborted", async () => {
    const abortController = new AbortController();
    abortController.abort();

    const handler = vi.fn();
    const plugins: RfmediaPlugin[] = [
      {
        name: "plugin",
        version: "1.0.0",
        hooks: [
          {
            type: "beforeCopy",
            handler,
          } as BeforeCopyHook,
        ],
      },
    ];

    const results = await runBeforeCopyHooks(plugins, createBeforeCopyContext(), {
      signal: abortController.signal,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it("should track duration in milliseconds", async () => {
    const plugins: RfmediaPlugin[] = [
      {
        name: "slow-plugin",
        version: "1.0.0",
        hooks: [
          {
            type: "beforeCopy",
            handler: async () => {
              await new Promise((resolve) => setTimeout(resolve, 10));
            },
          } as BeforeCopyHook,
        ],
      },
    ];

    const results = await runBeforeCopyHooks(plugins, createBeforeCopyContext());

    // setTimeout(10) can fire ~1ms early relative to performance.now()
    // (libuv timers use ms-resolution wall clock), so allow 1ms of slack
    expect(results[0]?.durationMs).toBeGreaterThanOrEqual(9);
  });
});

describe("runAfterCopyHooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createAfterCopyContext = (): AfterCopyContext => ({
    sourcePath: "/source/file.flac",
    destPath: "/dest/file.flac",
    method: "copy",
    fileSize: 50000000,
  });

  const createCopyResult = (): CopyResult => ({
    source: "/source",
    created: 10,
    skipped: 2,
    filtered: 0,
    failed: [],
  });

  it("should execute hooks with context and result", async () => {
    const receivedContext: AfterCopyContext[] = [];
    const receivedResults: CopyResult[] = [];

    const plugins: RfmediaPlugin[] = [
      {
        name: "plugin",
        version: "1.0.0",
        hooks: [
          {
            type: "afterCopy",
            handler: async (ctx, result) => {
              receivedContext.push(ctx);
              receivedResults.push(result);
            },
          } as AfterCopyHook,
        ],
      },
    ];

    const context = createAfterCopyContext();
    const result = createCopyResult();
    await runAfterCopyHooks(plugins, context, result);

    expect(receivedContext).toHaveLength(1);
    expect(receivedContext[0]).toBe(context);
    expect(receivedResults).toHaveLength(1);
    expect(receivedResults[0]).toBe(result);
  });

  it("should execute in priority order", async () => {
    const executionOrder: string[] = [];

    const plugins: RfmediaPlugin[] = [
      {
        name: "high",
        version: "1.0.0",
        priority: 100,
        hooks: [
          {
            type: "afterCopy",
            handler: async () => {
              executionOrder.push("high");
            },
          } as AfterCopyHook,
        ],
      },
      {
        name: "low",
        version: "1.0.0",
        priority: 1,
        hooks: [
          {
            type: "afterCopy",
            handler: async () => {
              executionOrder.push("low");
            },
          } as AfterCopyHook,
        ],
      },
    ];

    await runAfterCopyHooks(plugins, createAfterCopyContext(), createCopyResult());

    expect(executionOrder).toEqual(["low", "high"]);
  });

  it("should handle errors with continueOnError", async () => {
    const plugins: RfmediaPlugin[] = [
      {
        name: "failing",
        version: "1.0.0",
        hooks: [
          {
            type: "afterCopy",
            handler: async () => {
              throw new Error("afterCopy failed");
            },
          } as AfterCopyHook,
        ],
      },
    ];

    const results = await runAfterCopyHooks(plugins, createAfterCopyContext(), createCopyResult());

    expect(results[0]?.success).toBe(false);
    expect(results[0]?.error?.message).toContain("afterCopy failed");
  });
});

describe("runProcessFileHooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createProcessFileContext = (): ProcessFileContext => ({
    filePath: "/music/track.flac",
    metadata: {
      artist: "Test Artist",
      album: "Test Album",
      title: "Test Track",
      rating: null,
      format: { container: "FLAC" },
      common: {},
    } as unknown as ProcessFileContext["metadata"],
  });

  it("should execute processFile hooks", async () => {
    const receivedContext: ProcessFileContext[] = [];

    const plugins: RfmediaPlugin[] = [
      {
        name: "plugin",
        version: "1.0.0",
        hooks: [
          {
            type: "processFile",
            handler: async (ctx) => {
              receivedContext.push(ctx);
            },
          } as ProcessFileHook,
        ],
      },
    ];

    const context = createProcessFileContext();
    await runProcessFileHooks(plugins, context);

    expect(receivedContext).toHaveLength(1);
    expect(receivedContext[0]?.filePath).toBe("/music/track.flac");
  });

  it("should skip plugins without processFile hooks", async () => {
    const plugins: RfmediaPlugin[] = [
      {
        name: "wrong-hook",
        version: "1.0.0",
        hooks: [
          {
            type: "beforeCopy",
            handler: async () => {},
          } as BeforeCopyHook,
        ],
      },
    ];

    const results = await runProcessFileHooks(plugins, createProcessFileContext());

    expect(results).toEqual([]);
  });

  it("should respect abort signal", async () => {
    const abortController = new AbortController();
    abortController.abort();

    const handler = vi.fn();
    const plugins: RfmediaPlugin[] = [
      {
        name: "plugin",
        version: "1.0.0",
        hooks: [
          {
            type: "processFile",
            handler,
          } as ProcessFileHook,
        ],
      },
    ];

    await runProcessFileHooks(plugins, createProcessFileContext(), {
      signal: abortController.signal,
    });

    expect(handler).not.toHaveBeenCalled();
  });
});

describe("runAfterBatchHooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createAfterBatchContext = (): AfterBatchContext => ({
    results: [
      { source: "/src1", created: 5, skipped: 0, filtered: 0, failed: [] },
      { source: "/src2", created: 10, skipped: 1, filtered: 0, failed: [] },
    ],
    sources: ["/src1", "/src2"],
    historyId: "session-123",
  });

  it("should execute afterBatch hooks with full context", async () => {
    const receivedContext: AfterBatchContext[] = [];

    const plugins: RfmediaPlugin[] = [
      {
        name: "plugin",
        version: "1.0.0",
        hooks: [
          {
            type: "afterBatch",
            handler: async (ctx) => {
              receivedContext.push(ctx);
            },
          } as AfterBatchHook,
        ],
      },
    ];

    const context = createAfterBatchContext();
    await runAfterBatchHooks(plugins, context);

    expect(receivedContext).toHaveLength(1);
    expect(receivedContext[0]?.sources).toEqual(["/src1", "/src2"]);
    expect(receivedContext[0]?.historyId).toBe("session-123");
    expect(receivedContext[0]?.results).toHaveLength(2);
  });

  it("should pass signal to afterBatch context", async () => {
    const abortController = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    const plugins: RfmediaPlugin[] = [
      {
        name: "plugin",
        version: "1.0.0",
        hooks: [
          {
            type: "afterBatch",
            handler: async (ctx) => {
              receivedSignal = ctx.signal;
            },
          } as AfterBatchHook,
        ],
      },
    ];

    const context: AfterBatchContext = {
      ...createAfterBatchContext(),
      signal: abortController.signal,
    };

    await runAfterBatchHooks(plugins, context);

    expect(receivedSignal).toBe(abortController.signal);
  });

  it("should collect multiple errors", async () => {
    const plugins: RfmediaPlugin[] = [
      {
        name: "failing1",
        version: "1.0.0",
        hooks: [
          {
            type: "afterBatch",
            handler: async () => {
              throw new Error("Error 1");
            },
          } as AfterBatchHook,
        ],
      },
      {
        name: "failing2",
        version: "1.0.0",
        hooks: [
          {
            type: "afterBatch",
            handler: async () => {
              throw new Error("Error 2");
            },
          } as AfterBatchHook,
        ],
      },
    ];

    const results = await runAfterBatchHooks(plugins, createAfterBatchContext());

    expect(results).toHaveLength(2);
    expect(results.filter((r) => !r.success)).toHaveLength(2);
  });
});

describe("summarizeHookResults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should count successful and failed hooks", () => {
    const results: HookResult[] = [
      { pluginName: "p1", success: true, durationMs: 10 },
      { pluginName: "p2", success: true, durationMs: 20 },
      {
        pluginName: "p3",
        success: false,
        error: new PluginExecutionError("p3", "test", new Error("failed")),
        durationMs: 5,
      },
    ];

    const summary = summarizeHookResults(results);

    expect(summary.total).toBe(3);
    expect(summary.successful).toBe(2);
    expect(summary.failed).toBe(1);
  });

  it("should collect PluginExecutionError instances", () => {
    const error1 = new PluginExecutionError("p1", "beforeCopy", new Error("err1"));
    const error2 = new PluginExecutionError("p2", "afterCopy", new Error("err2"));

    const results: HookResult[] = [
      { pluginName: "p1", success: false, error: error1, durationMs: 10 },
      { pluginName: "p2", success: false, error: error2, durationMs: 20 },
    ];

    const summary = summarizeHookResults(results);

    expect(summary.errors).toHaveLength(2);
    expect(summary.errors[0]).toBe(error1);
    expect(summary.errors[1]).toBe(error2);
  });

  it("should wrap non-PluginExecutionError errors", () => {
    const genericError = new Error("generic error");

    const results: HookResult[] = [
      { pluginName: "plugin", success: false, error: genericError, durationMs: 10 },
    ];

    const summary = summarizeHookResults(results);

    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toBeInstanceOf(PluginExecutionError);
    expect(summary.errors[0]?.pluginName).toBe("plugin");
    expect(summary.errors[0]?.hookType).toBe("unknown");
  });

  it("should return empty errors array for all success", () => {
    const results: HookResult[] = [
      { pluginName: "p1", success: true, durationMs: 10 },
      { pluginName: "p2", success: true, durationMs: 20 },
    ];

    const summary = summarizeHookResults(results);

    expect(summary.errors).toEqual([]);
    expect(summary.failed).toBe(0);
  });

  it("should handle empty results array", () => {
    const summary = summarizeHookResults([]);

    expect(summary.total).toBe(0);
    expect(summary.successful).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.errors).toEqual([]);
  });

  it("should handle failed result without error property", () => {
    const results: HookResult[] = [{ pluginName: "plugin", success: false, durationMs: 10 }];

    const summary = summarizeHookResults(results);

    expect(summary.failed).toBe(1);
    expect(summary.errors).toEqual([]);
  });
});
