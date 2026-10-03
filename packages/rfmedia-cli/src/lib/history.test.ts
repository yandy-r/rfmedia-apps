import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { cleanupTempDir, createTempTestDir } from "../test-utils/filesystem.js";
import {
  closeDatabase,
  closeHistorySession,
  createHistorySession,
  findHistorySession,
  getHistoryOperations,
  initializeDatabase,
} from "./db.js";
import { migrateLegacyHistory } from "./history.js";
import type { DbConnection } from "../types/db.js";
import type { HistoryEntry, HistorySessionHeader } from "../types/index.js";

const STARTED_AT = "2026-01-16T15:30:45.000Z";
const ENDED_AT = "2026-01-16T15:31:45.000Z";

describe("migrateLegacyHistory", () => {
  let tempDir: string;
  let db: DbConnection;
  let historyDir: string;

  beforeEach(async () => {
    tempDir = await createTempTestDir("rfmedia-history-migration-");
    historyDir = join(tempDir, "custom-history");
    await mkdir(historyDir, { recursive: true });
    db = await initializeDatabase(join(tempDir, "tracking.db"));
  });

  afterEach(async () => {
    closeDatabase(db);
    await cleanupTempDir(tempDir);
  });

  async function writeSession(
    sessionId: string,
    entries: HistoryEntry[],
    headerOverrides: Partial<HistorySessionHeader> = {},
  ): Promise<string> {
    const header: HistorySessionHeader = {
      _header: true,
      version: "1",
      command: "copy",
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      status: "pending",
      cwd: "/music",
      operationCount: entries.length,
      ...headerOverrides,
    };
    const filePath = join(historyDir, `${sessionId}.jsonl`);
    await writeFile(
      filePath,
      [JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry))].join("\n") + "\n",
      "utf-8",
    );
    return filePath;
  }

  it("imports a complete session from the explicitly resolved history directory", async () => {
    const sessionId = "2026-01-16T15-30-45Z-copy-12345";
    const entries: HistoryEntry[] = [
      {
        op: "copy",
        at: "2026-01-16T15:30:46.000Z",
        src: "/music/source.flac",
        dest: "/export/destination.flac",
      },
      {
        op: "mkdir",
        at: "2026-01-16T15:30:47.000Z",
        dest: "/export/album",
        created: true,
      },
    ];
    const filePath = await writeSession(sessionId, entries, { status: "partial" });

    const result = await migrateLegacyHistory(db, historyDir);

    expect(result).toEqual({
      sessions: 1,
      operations: 2,
      importedFiles: [filePath],
      alreadyEquivalentFiles: [],
      failedFiles: [],
    });
    const stored = findHistorySession(db, sessionId);
    expect(stored).toMatchObject({
      session_id: sessionId,
      command: "copy",
      ended_at: ENDED_AT,
      status: "partial",
      operation_count: 2,
    });
    expect(getHistoryOperations(db, stored!.id)).toMatchObject([
      {
        operation_type: "copy",
        occurred_at: entries[0]!.at,
        source_path: "/music/source.flac",
        dest_path: "/export/destination.flac",
      },
      {
        operation_type: "mkdir",
        occurred_at: entries[1]!.at,
        dest_path: "/export/album",
        created_dir: 1,
      },
    ]);
    expect(await readFile(filePath, "utf-8")).toContain('"operationCount":2');
  });

  it("retains a malformed complete-session candidate without partial database state", async () => {
    const sessionId = "2026-01-16T16-00-00Z-copy-12345";
    const filePath = join(historyDir, `${sessionId}.jsonl`);
    const header: HistorySessionHeader = {
      _header: true,
      version: "1",
      command: "copy",
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      status: "pending",
      cwd: "/music",
      operationCount: 2,
    };
    await writeFile(
      filePath,
      `${JSON.stringify(header)}\n${JSON.stringify({ op: "remove", at: ENDED_AT, dest: "/one" })}\nnot-json\n`,
      "utf-8",
    );

    const result = await migrateLegacyHistory(db, historyDir);

    expect(result.sessions).toBe(0);
    expect(result.importedFiles).toEqual([]);
    expect(result.failedFiles).toEqual([
      { filePath, error: "Invalid history entry JSON at line 3" },
    ]);
    expect(findHistorySession(db, sessionId)).toBeNull();
    expect(await readFile(filePath, "utf-8")).toContain("not-json");
  });

  it("rejects parseable timestamps that do not match the writer ISO format", async () => {
    const sessionId = "2026-01-16T16-30-00Z-copy-12345";
    const filePath = await writeSession(sessionId, [{ op: "remove", at: ENDED_AT, dest: "/one" }], {
      startedAt: "2020",
    });

    const result = await migrateLegacyHistory(db, historyDir);

    expect(result.sessions).toBe(0);
    expect(result.importedFiles).toEqual([]);
    expect(result.failedFiles).toEqual([{ filePath, error: "History session is incomplete" }]);
    expect(findHistorySession(db, sessionId)).toBeNull();
  });

  it("retains a legacy file when its session identity conflicts with durable data", async () => {
    const sessionId = "2026-01-16T17-00-00Z-copy-12345";
    const filePath = await writeSession(sessionId, [
      { op: "remove", at: ENDED_AT, dest: "/legacy/path" },
    ]);
    const dbSessionId = createHistorySession(db, {
      sessionId,
      version: "1",
      command: "clean",
      startedAt: STARTED_AT,
      cwd: "/other",
    });
    closeHistorySession(db, dbSessionId, ENDED_AT, 0);

    const result = await migrateLegacyHistory(db, historyDir);

    expect(result.alreadyEquivalentFiles).toEqual([]);
    expect(result.failedFiles).toEqual([
      {
        filePath,
        error: `Database session conflicts with legacy history: ${sessionId}`,
      },
    ]);
    expect(findHistorySession(db, sessionId)).toMatchObject({
      command: "clean",
      cwd: "/other",
      operation_count: 0,
    });
    expect(await readFile(filePath, "utf-8")).toContain("/legacy/path");
  });

  it("reports an already-equivalent file without duplicating rows", async () => {
    const sessionId = "2026-01-16T18-00-00Z-copy-12345";
    const filePath = await writeSession(sessionId, [
      {
        op: "hardlink",
        at: ENDED_AT,
        src: "/music/source.flac",
        dest: "/export/destination.flac",
      },
    ]);
    const first = await migrateLegacyHistory(db, historyDir);

    const second = await migrateLegacyHistory(db, historyDir);

    expect(first.importedFiles).toEqual([filePath]);
    expect(second).toEqual({
      sessions: 0,
      operations: 0,
      importedFiles: [],
      alreadyEquivalentFiles: [filePath],
      failedFiles: [],
    });
    const stored = findHistorySession(db, sessionId);
    expect(getHistoryOperations(db, stored!.id)).toHaveLength(1);
  });

  it("rolls back the session when an operation write fails", async () => {
    const sessionId = "2026-01-16T19-00-00Z-copy-12345";
    const filePath = await writeSession(sessionId, [
      { op: "trash", at: ENDED_AT, dest: "/export/destination.flac" },
    ]);
    db.exec(`
      CREATE TRIGGER fail_history_operation
      BEFORE INSERT ON history_operations
      BEGIN
        SELECT RAISE(ABORT, 'injected history operation failure');
      END;
    `);

    const result = await migrateLegacyHistory(db, historyDir);

    expect(result.sessions).toBe(0);
    expect(result.operations).toBe(0);
    expect(result.importedFiles).toEqual([]);
    expect(result.failedFiles).toEqual([{ filePath, error: "injected history operation failure" }]);
    expect(findHistorySession(db, sessionId)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM history_operations").get()).toMatchObject({
      count: 0,
    });
    expect(await readFile(filePath, "utf-8")).toContain("/export/destination.flac");
  });
});
