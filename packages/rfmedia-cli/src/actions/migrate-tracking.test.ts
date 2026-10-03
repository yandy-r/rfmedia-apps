import { dirname, join, resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fastGlob: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  unlink: vi.fn(),
  lstat: vi.fn(),
  open: vi.fn(),
  realpath: vi.fn(),
  openedParents: new Map<number, string>(),
  nextFd: { value: 40 },
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  getLoadedConfig: vi.fn(),
  resolveUndoDatabasePath: vi.fn(),
  getHistoryDir: vi.fn(),
  migrateLegacyHistory: vi.fn(),
  migrateLegacyTracking: vi.fn(),
  pathExists: vi.fn(),
  confirm: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logSuccess: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("fast-glob", () => ({ default: mocks.fastGlob }));

vi.mock("node:fs/promises", () => ({
  readdir: mocks.readdir,
  readFile: mocks.readFile,
  unlink: mocks.unlink,
  lstat: mocks.lstat,
  open: mocks.open,
  realpath: mocks.realpath,
}));

vi.mock("../lib/db.js", () => ({
  initializeDatabase: mocks.initializeDatabase,
  closeDatabase: mocks.closeDatabase,
}));

vi.mock("../lib/loaded-config.js", () => ({
  getLoadedConfig: mocks.getLoadedConfig,
}));

vi.mock("../lib/config.js", () => ({
  resolveUndoDatabasePath: mocks.resolveUndoDatabasePath,
}));

vi.mock("../lib/history.js", () => ({
  getHistoryDir: mocks.getHistoryDir,
  migrateLegacyHistory: mocks.migrateLegacyHistory,
}));

vi.mock("../lib/completed-tracker.js", () => ({
  migrateLegacyTracking: mocks.migrateLegacyTracking,
}));

vi.mock("../lib/filesystem.js", () => ({
  pathExists: mocks.pathExists,
}));

vi.mock("../lib/prompt.js", () => ({ confirm: mocks.confirm }));

vi.mock("../lib/logger.js", () => ({
  formatDryRun: (message: string) => `[dry-run] ${message}`,
  logDebug: mocks.logDebug,
  logError: mocks.logError,
  logInfo: mocks.logInfo,
  logSuccess: mocks.logSuccess,
  logWarn: mocks.logWarn,
}));

import { executeMigrate } from "./migrate-tracking.js";
import type { MigrateOptions } from "../types/options.js";

const db = { name: "test-db" };
const historyRoot = "/virtual/history";

function options(overrides: Partial<MigrateOptions> = {}): MigrateOptions {
  return {
    deleteOld: false,
    force: false,
    trackingOnly: false,
    historyOnly: false,
    dryRun: false,
    ...overrides,
  };
}

function trackingPath(input: string, type: "completed" | "failed", hash: string): string {
  return join(process.cwd(), `${input}.${type}.${hash}.txt`);
}

function historyEntry(name: string): { name: string; isFile: () => boolean } {
  return { name, isFile: () => true };
}

function historyContent(command = "copy", operations = 1): string {
  const header = JSON.stringify({
    _header: true,
    command,
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  return [header, ...Array.from({ length: operations }, () => JSON.stringify({ op: "copy" }))].join(
    "\n",
  );
}

function regularStat(path: string): {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
} {
  const identity = [...path].reduce((value, character) => value + character.charCodeAt(0), 0);
  return {
    dev: 1,
    ino: identity,
    size: 100,
    mtimeMs: 1_000,
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  };
}

function directoryStat(path: string): ReturnType<typeof regularStat> {
  return {
    ...regularStat(path),
    isFile: () => false,
    isDirectory: () => true,
  };
}

function resolveMockPath(path: string): string {
  const match = path.match(/^\/proc\/self\/fd\/(\d+)\/(.+)$/);
  if (!match) return resolve(path);
  const parent = mocks.openedParents.get(Number(match[1]));
  return parent ? join(parent, match[2] as string) : resolve(path);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.openedParents.clear();
  mocks.nextFd.value = 40;
  mocks.fastGlob.mockResolvedValue([]);
  mocks.readdir.mockResolvedValue([]);
  mocks.readFile.mockResolvedValue("");
  mocks.unlink.mockResolvedValue(undefined);
  mocks.lstat.mockImplementation(async (path: string) => {
    const resolvedPath = resolveMockPath(path);
    return /\.(?:txt|jsonl)$/.test(resolvedPath)
      ? regularStat(resolvedPath)
      : directoryStat(resolvedPath);
  });
  mocks.open.mockImplementation(async (path: string) => {
    const resolvedPath = resolve(path);
    const fd = mocks.nextFd.value++;
    mocks.openedParents.set(fd, resolvedPath);
    return {
      fd,
      stat: vi.fn(async () => directoryStat(resolvedPath)),
      close: vi.fn(async () => undefined),
    };
  });
  mocks.realpath.mockImplementation(async (path: string) => resolveMockPath(path));
  mocks.initializeDatabase.mockResolvedValue(db);
  mocks.closeDatabase.mockReturnValue(undefined);
  mocks.getLoadedConfig.mockReturnValue({});
  mocks.resolveUndoDatabasePath.mockReturnValue("/virtual/tracking.db");
  mocks.getHistoryDir.mockReturnValue(historyRoot);
  mocks.migrateLegacyHistory.mockResolvedValue({
    sessions: 0,
    operations: 0,
    importedFiles: [],
    alreadyEquivalentFiles: [],
    failedFiles: [],
  });
  mocks.migrateLegacyTracking.mockResolvedValue({
    operationId: 1,
    completed: 0,
    failed: 0,
    importedFiles: [],
    alreadyEquivalentFiles: [],
  });
  mocks.pathExists.mockResolvedValue(true);
  mocks.confirm.mockResolvedValue(true);
});

describe("executeMigrate", () => {
  it("previews distinct equal-hash tracking inputs without opening persistent boundaries", async () => {
    const alpha = trackingPath("alpha", "completed", "album-001-002");
    const beta = trackingPath("beta", "failed", "album-001-002");
    mocks.fastGlob.mockResolvedValue([alpha, beta, join(process.cwd(), "not-a-sidecar.txt")]);
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path === alpha) return "# header\n/music/a\n\n/music/b\n";
      if (path === beta) return "# header\n/music/c\n";
      return "";
    });

    const result = await executeMigrate(options({ dryRun: true, trackingOnly: true }));

    expect(result.tracking).toMatchObject({ operations: 2, sources: 3 });
    expect(result.tracking.legacyFiles.map((file) => file.inputFile)).toEqual([
      join(process.cwd(), "alpha"),
      join(process.cwd(), "beta"),
    ]);
    expect(mocks.initializeDatabase).not.toHaveBeenCalled();
    expect(mocks.migrateLegacyTracking).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.unlink).not.toHaveBeenCalled();
    expect(mocks.closeDatabase).not.toHaveBeenCalled();
  });

  it("imports distinct tracking identities and history from one explicit root", async () => {
    const alpha = trackingPath("alpha", "completed", "filter-r80");
    const beta = trackingPath("beta", "completed", "filter-r80");
    const historyFile = join(historyRoot, "session-a.jsonl");
    mocks.fastGlob.mockResolvedValue([alpha, beta]);
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path === historyFile) return historyContent("copy", 1);
      return "/music/source\n";
    });
    mocks.readdir.mockResolvedValue([historyEntry("session-a.jsonl")]);
    mocks.migrateLegacyTracking
      .mockResolvedValueOnce({
        operationId: 1,
        completed: 1,
        failed: 0,
        importedFiles: [alpha],
        alreadyEquivalentFiles: [],
      })
      .mockResolvedValueOnce({
        operationId: 2,
        completed: 1,
        failed: 0,
        importedFiles: [],
        alreadyEquivalentFiles: [beta],
      });
    mocks.migrateLegacyHistory.mockResolvedValue({
      sessions: 1,
      operations: 1,
      importedFiles: [historyFile],
      alreadyEquivalentFiles: [],
      failedFiles: [],
    });

    const result = await executeMigrate(options({ historyPath: historyRoot }));

    expect(mocks.migrateLegacyTracking).toHaveBeenNthCalledWith(1, db, {
      inputFile: join(dirname(alpha), "alpha"),
      optionsHash: "filter-r80",
      mode: "filter",
      completedPath: alpha,
    });
    expect(mocks.migrateLegacyTracking).toHaveBeenNthCalledWith(2, db, {
      inputFile: join(dirname(beta), "beta"),
      optionsHash: "filter-r80",
      mode: "filter",
      completedPath: beta,
    });
    expect(mocks.migrateLegacyHistory).toHaveBeenCalledWith(db, historyRoot);
    expect(result.tracking).toMatchObject({ operations: 2, sources: 2 });
    expect(result.history).toMatchObject({ sessions: 1, operations: 1 });
    expect(mocks.closeDatabase).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["malformed hash", [trackingPath("artists", "completed", "unsupported")]],
    [
      "duplicate member",
      [
        trackingPath("artists", "completed", "album-001-002"),
        trackingPath("artists", "completed", "album-001-002"),
      ],
    ],
  ])("rejects a %s group and still closes the database", async (_name, files) => {
    mocks.fastGlob.mockResolvedValue(files);
    mocks.readFile.mockResolvedValue("/music/source\n");

    await expect(executeMigrate(options({ trackingOnly: true }))).rejects.toThrow();

    expect(mocks.migrateLegacyTracking).not.toHaveBeenCalled();
    expect(mocks.unlink).not.toHaveBeenCalled();
    expect(mocks.closeDatabase).toHaveBeenCalledTimes(1);
  });

  it("routes tracking-only and history-only without touching the skipped domain", async () => {
    await executeMigrate(options({ trackingOnly: true }));
    expect(mocks.fastGlob).toHaveBeenCalledTimes(1);
    expect(mocks.readdir).not.toHaveBeenCalled();
    expect(mocks.migrateLegacyHistory).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.readdir.mockResolvedValue([historyEntry("session-a.jsonl")]);
    mocks.readFile.mockResolvedValue(historyContent());
    mocks.pathExists.mockResolvedValue(true);
    mocks.initializeDatabase.mockResolvedValue(db);
    mocks.getLoadedConfig.mockReturnValue({});
    mocks.resolveUndoDatabasePath.mockReturnValue("/virtual/tracking.db");
    mocks.getHistoryDir.mockReturnValue(historyRoot);
    mocks.migrateLegacyHistory.mockResolvedValue({
      sessions: 0,
      operations: 0,
      importedFiles: [],
      alreadyEquivalentFiles: [],
      failedFiles: [],
    });

    await executeMigrate(options({ historyOnly: true }));
    expect(mocks.fastGlob).not.toHaveBeenCalled();
    expect(mocks.readdir).toHaveBeenCalledTimes(1);
    expect(mocks.migrateLegacyHistory).toHaveBeenCalledTimes(1);
    expect(mocks.migrateLegacyTracking).not.toHaveBeenCalled();
  });

  it("reports malformed history even when discovery cannot classify its header", async () => {
    const malformed = join(historyRoot, "malformed.jsonl");
    mocks.readdir.mockResolvedValue([historyEntry("malformed.jsonl")]);
    mocks.readFile.mockResolvedValue("not json");
    mocks.migrateLegacyHistory.mockResolvedValue({
      sessions: 0,
      operations: 0,
      importedFiles: [],
      alreadyEquivalentFiles: [],
      failedFiles: [{ filePath: malformed, error: "Invalid history session header JSON" }],
    });

    const result = await executeMigrate(options({ historyOnly: true }));

    expect(result.history.legacyFiles).toEqual([]);
    expect(result.errors).toContainEqual({
      path: malformed,
      message: "Invalid history session header JSON",
    });
    expect(mocks.migrateLegacyHistory).toHaveBeenCalledWith(db, historyRoot);
    expect(mocks.closeDatabase).toHaveBeenCalledTimes(1);
  });

  it("deletes only proven files after confirmation and retains failed history", async () => {
    const completed = trackingPath("artists", "completed", "album-001-002");
    const failed = trackingPath("artists", "failed", "album-001-002");
    const importedHistory = join(historyRoot, "imported.jsonl");
    const failedHistory = join(historyRoot, "failed.jsonl");
    mocks.fastGlob.mockResolvedValue([completed, failed]);
    mocks.readdir.mockResolvedValue([historyEntry("imported.jsonl"), historyEntry("failed.jsonl")]);
    mocks.readFile.mockImplementation(async (path: string) =>
      path.endsWith(".jsonl") ? historyContent() : "/music/source\n",
    );
    mocks.migrateLegacyTracking.mockImplementation(async (_db, request) => ({
      operationId: 1,
      completed: 1,
      failed: 1,
      importedFiles: [request.completedPath],
      alreadyEquivalentFiles: [],
    }));
    mocks.migrateLegacyHistory.mockImplementation(async (_db, root: string) => ({
      sessions: 1,
      operations: 1,
      importedFiles: [join(root, "imported.jsonl")],
      alreadyEquivalentFiles: [],
      failedFiles: [{ filePath: join(root, "failed.jsonl"), error: "malformed operation" }],
    }));

    const result = await executeMigrate(options({ deleteOld: true }));

    expect(mocks.confirm).toHaveBeenCalledWith("Delete 2 legacy file(s)?");
    expect(mocks.unlink.mock.calls.map(([path]) => path)).toEqual([
      expect.stringMatching(/^\/proc\/self\/fd\/\d+\/artists\.completed\.album-001-002\.txt$/),
      expect.stringMatching(/^\/proc\/self\/fd\/\d+\/imported\.jsonl$/),
    ]);
    expect(result.filesDeleted).toBe(2);
    expect(result.errors).toContainEqual({
      path: failedHistory,
      message: "malformed operation",
    });
    expect(mocks.unlink).not.toHaveBeenCalledWith(failed);
    expect(mocks.unlink).not.toHaveBeenCalledWith(failedHistory);
  });

  it("keeps proven files when confirmation is declined", async () => {
    const completed = trackingPath("artists", "completed", "album-001-002");
    mocks.fastGlob.mockResolvedValue([completed]);
    mocks.readFile.mockResolvedValue("/music/source\n");
    mocks.migrateLegacyTracking.mockImplementation(async (_db, request) => ({
      operationId: 1,
      completed: 1,
      failed: 0,
      importedFiles: [request.completedPath],
      alreadyEquivalentFiles: [],
    }));
    mocks.confirm.mockResolvedValue(false);

    const result = await executeMigrate(options({ deleteOld: true, trackingOnly: true }));

    expect(result.filesDeleted).toBe(0);
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it("uses force only to bypass confirmation and continues after an unlink failure", async () => {
    const completed = trackingPath("artists", "completed", "album-001-002");
    const failed = trackingPath("artists", "failed", "album-001-002");
    mocks.fastGlob.mockResolvedValue([completed, failed]);
    mocks.readFile.mockResolvedValue("/music/source\n");
    mocks.migrateLegacyTracking.mockImplementation(async (_db, request) => ({
      operationId: 1,
      completed: 1,
      failed: 1,
      importedFiles: [request.completedPath, request.failedPath],
      alreadyEquivalentFiles: [],
    }));
    const unlinkError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    mocks.unlink.mockRejectedValueOnce(unlinkError).mockResolvedValueOnce(undefined);

    const result = await executeMigrate(
      options({ deleteOld: true, force: true, trackingOnly: true }),
    );

    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.unlink).toHaveBeenCalledTimes(2);
    expect(result.filesDeleted).toBe(1);
    expect(result.errors).toContainEqual({
      path: completed,
      message: "permission denied",
      code: "EACCES",
    });
  });

  it("refuses a proven symlink even when force is set", async () => {
    const completed = trackingPath("artists", "completed", "album-001-002");
    mocks.fastGlob.mockResolvedValue([completed]);
    mocks.readFile.mockResolvedValue("/music/source\n");
    mocks.migrateLegacyTracking.mockImplementation(async (_db, request) => ({
      operationId: 1,
      completed: 1,
      failed: 0,
      importedFiles: [request.completedPath],
      alreadyEquivalentFiles: [],
    }));
    mocks.lstat.mockResolvedValue({
      ...regularStat(completed),
      isFile: () => false,
      isSymbolicLink: () => true,
    });

    const result = await executeMigrate(
      options({ deleteOld: true, force: true, trackingOnly: true }),
    );

    expect(result.filesDeleted).toBe(0);
    expect(result.errors[0]).toMatchObject({ path: completed });
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it("refuses importer proof outside the captured discovery root", async () => {
    const outside = "/outside/artists.completed.album-001-002.txt";
    mocks.fastGlob.mockResolvedValue([outside]);
    mocks.readFile.mockResolvedValue("/music/source\n");
    mocks.migrateLegacyTracking.mockResolvedValue({
      operationId: 1,
      completed: 1,
      failed: 0,
      importedFiles: [outside],
      alreadyEquivalentFiles: [],
    });

    const result = await executeMigrate(
      options({ deleteOld: true, force: true, trackingOnly: true }),
    );

    expect(result.errors[0]).toMatchObject({ path: outside });
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it("revalidates a proven file identity immediately before unlink", async () => {
    const completed = trackingPath("artists", "completed", "album-001-002");
    const initialStat = regularStat(completed);
    let anchoredChecks = 0;
    mocks.fastGlob.mockResolvedValue([completed]);
    mocks.readFile.mockResolvedValue("/music/source\n");
    mocks.migrateLegacyTracking.mockImplementation(async (_db, request) => ({
      operationId: 1,
      completed: 1,
      failed: 0,
      importedFiles: [request.completedPath],
      alreadyEquivalentFiles: [],
    }));
    mocks.lstat.mockImplementation(async (path: string) => {
      const resolvedPath = resolveMockPath(path);
      if (!/\.(?:txt|jsonl)$/.test(resolvedPath)) return directoryStat(resolvedPath);
      if (path.startsWith("/proc/self/fd/")) anchoredChecks++;
      return anchoredChecks >= 3 ? { ...initialStat, ino: initialStat.ino + 1 } : initialStat;
    });

    const result = await executeMigrate(
      options({ deleteOld: true, force: true, trackingOnly: true }),
    );

    expect(result.errors[0]).toMatchObject({ path: completed });
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it("imports and deletes through the captured identity when its pathname is replaced", async () => {
    const completed = trackingPath("artists", "completed", "album-001-002");
    const initialStat = regularStat(completed);
    let replaced = false;
    mocks.fastGlob.mockResolvedValue([completed]);
    mocks.readFile.mockResolvedValue("/music/source\n");
    mocks.lstat.mockImplementation(async (path: string) => {
      const resolvedPath = resolveMockPath(path);
      if (!/\.(?:txt|jsonl)$/.test(resolvedPath)) return directoryStat(resolvedPath);
      if (path.startsWith("/proc/self/fd/")) return initialStat;
      return replaced ? { ...initialStat, ino: initialStat.ino + 1 } : initialStat;
    });
    mocks.migrateLegacyTracking.mockImplementation(async (_db, request) => {
      expect(request.completedPath).toMatch(/^\/proc\/self\/fd\/\d+\//);
      replaced = true;
      return {
        operationId: 1,
        completed: 1,
        failed: 0,
        importedFiles: [request.completedPath],
        alreadyEquivalentFiles: [],
      };
    });

    const result = await executeMigrate(
      options({ deleteOld: true, force: true, trackingOnly: true }),
    );

    expect(result.errors).toEqual([]);
    expect(result.filesDeleted).toBe(1);
    expect(mocks.unlink).toHaveBeenCalledWith(expect.stringMatching(/^\/proc\/self\/fd\/\d+\//));
  });

  it("imports history through the captured directory identity before deleting it", async () => {
    const historyFile = join(historyRoot, "session-a.jsonl");
    mocks.readdir.mockResolvedValue([historyEntry("session-a.jsonl")]);
    mocks.readFile.mockResolvedValue(historyContent());
    mocks.migrateLegacyHistory.mockImplementation(async (_db, root: string) => {
      expect(root).toMatch(/^\/proc\/self\/fd\/\d+$/);
      return {
        sessions: 1,
        operations: 1,
        importedFiles: [join(root, "session-a.jsonl")],
        alreadyEquivalentFiles: [],
        failedFiles: [],
      };
    });

    const result = await executeMigrate(
      options({ deleteOld: true, force: true, historyOnly: true }),
    );

    expect(result).toMatchObject({ filesDeleted: 1, errors: [] });
    expect(mocks.unlink).toHaveBeenCalledWith(
      expect.stringMatching(/^\/proc\/self\/fd\/\d+\/session-a\.jsonl$/),
    );
    expect(mocks.unlink).not.toHaveBeenCalledWith(historyFile);
  });

  it("retains a proven file when its captured root pathname is swapped before deletion", async () => {
    const completed = trackingPath("artists", "completed", "album-001-002");
    let rootSwapped = false;
    mocks.fastGlob.mockResolvedValue([completed]);
    mocks.readFile.mockResolvedValue("/music/source\n");
    mocks.migrateLegacyTracking.mockImplementation(async (_db, request) => ({
      operationId: 1,
      completed: 1,
      failed: 0,
      importedFiles: [request.completedPath],
      alreadyEquivalentFiles: [],
    }));
    mocks.realpath.mockImplementation(async (path: string) => {
      if (rootSwapped && resolve(path) === resolve(process.cwd())) return "/outside/swapped-root";
      return resolveMockPath(path);
    });
    mocks.confirm.mockImplementation(async () => {
      rootSwapped = true;
      return true;
    });

    const result = await executeMigrate(options({ deleteOld: true, trackingOnly: true }));

    expect(result.errors[0]).toMatchObject({ path: completed });
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it("records one tracking group failure and continues importing later groups", async () => {
    const alpha = trackingPath("alpha", "completed", "album-001-002");
    const beta = trackingPath("beta", "completed", "album-001-002");
    const importError = Object.assign(new Error("transaction failed"), { code: "EIO" });
    mocks.fastGlob.mockResolvedValue([alpha, beta]);
    mocks.readFile.mockResolvedValue("/music/source\n");
    mocks.migrateLegacyTracking
      .mockRejectedValueOnce(importError)
      .mockImplementationOnce(async (_db, request) => ({
        operationId: 2,
        completed: 1,
        failed: 0,
        importedFiles: [request.completedPath],
        alreadyEquivalentFiles: [],
      }));

    const result = await executeMigrate(
      options({ deleteOld: true, force: true, trackingOnly: true }),
    );

    expect(result.tracking).toMatchObject({ operations: 1, sources: 1 });
    expect(result.errors).toContainEqual({
      path: alpha,
      message: "transaction failed",
      code: "EIO",
    });
    expect(mocks.migrateLegacyTracking).toHaveBeenCalledTimes(2);
    expect(mocks.unlink).toHaveBeenCalledOnce();
    expect(mocks.unlink).toHaveBeenCalledWith(
      expect.stringMatching(/^\/proc\/self\/fd\/\d+\/beta\.completed\.album-001-002\.txt$/),
    );
    expect(mocks.unlink).not.toHaveBeenCalledWith(alpha);
    expect(mocks.closeDatabase).toHaveBeenCalledTimes(1);
  });
});
