/**
 * History recording and management for rfmedia CLI.
 *
 * Records filesystem operations to JSONL files in ~/.rfmedia/history/
 * for later undo operations. Each command invocation creates a session file.
 */

import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { logDebug, logWarn } from "./logger.js";
import { pathExists, remove } from "./filesystem.js";
import { getLoadedConfig } from "./loaded-config.js";
import {
  createHistorySession as createHistorySessionInDb,
  recordHistoryOperation,
  closeHistorySession as closeHistorySessionInDb,
  findHistorySession,
  getHistorySessions,
  getHistoryOperations,
  updateHistorySessionStatus as updateHistorySessionStatusInDb,
} from "./db.js";
import type {
  DbConnection,
  RecordHistoryOperationParams,
  DbHistoryOperation,
  HistorySessionFilter,
} from "../types/db.js";
import type {
  ConvertFormat,
  HistoryEntry,
  HistorySession,
  HistorySessionHeader,
  ListSessionsOptions,
  SessionStatus,
} from "../types/index.js";

/**
 * Current history format version.
 * Increment when making breaking changes to the format.
 */
const HISTORY_VERSION = "1";

/**
 * Default history directory path.
 */
const DEFAULT_HISTORY_DIR = join(homedir(), ".rfmedia", "history");

/**
 * Gets the history directory path from config or default.
 *
 * @returns Absolute path to history directory
 */
export function getHistoryDir(): string {
  const config = getLoadedConfig();
  return config.undo?.historyPath ?? DEFAULT_HISTORY_DIR;
}

/**
 * Checks if history recording is enabled.
 *
 * @returns True if history recording is enabled
 */
export function isHistoryEnabled(): boolean {
  const config = getLoadedConfig();
  return config.undo?.enabled !== false;
}

/**
 * Generates a session ID from the current timestamp, command, and PID.
 *
 * @param command - Command name (e.g., "copy", "clean")
 * @returns Session ID in format: YYYY-MM-DDTHH-MM-SSZ-command-pid
 */
function generateSessionId(command: string): string {
  const now = new Date();
  // Format: YYYY-MM-DDTHH-MM-SSZ (replacing colons with dashes for filename safety)
  const timestamp = now
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${command}-${process.pid}`;
}

/**
 * Gets the session file path for a session ID.
 *
 * @param sessionId - Session ID
 * @returns Absolute path to the session file
 */
function getSessionFilePath(sessionId: string): string {
  return join(getHistoryDir(), `${sessionId}.jsonl`);
}

/**
 * Extracts session ID from a session filename.
 *
 * @param filename - Filename (e.g., "2026-01-16T15-30-45Z-copy-12345.jsonl")
 * @returns Session ID without extension
 */
function extractSessionId(filename: string): string {
  return filename.replace(/\.jsonl$/, "");
}

/**
 * History recorder class for session-based operation logging.
 *
 * Each instance represents a single command session and logs operations
 * to a JSONL file or database. Create with `createHistorySession()`.
 */
export class HistoryRecorder {
  private readonly sessionId: string;
  private readonly filePath: string;
  private readonly command: string;
  private operationCount: number = 0;
  private closed: boolean = false;
  private readonly enabled: boolean;

  // Database mode fields
  private readonly db?: DbConnection;
  private readonly dbSessionId?: number;

  /**
   * Creates a new history recorder.
   * Use `createHistorySession()` instead of calling directly.
   *
   * @param command - Command name being executed
   * @param options - Optional database mode configuration
   */
  constructor(command: string, options?: { db?: DbConnection; dbSessionId?: number }) {
    this.command = command;
    this.sessionId = generateSessionId(command);
    this.filePath = getSessionFilePath(this.sessionId);
    this.enabled = isHistoryEnabled();
    this.db = options?.db;
    this.dbSessionId = options?.dbSessionId;
  }

  /**
   * Gets the session ID.
   */
  getId(): string {
    return this.sessionId;
  }

  /**
   * Gets the session file path.
   */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Initializes the session file with header (legacy mode) or validates database mode.
   * Must be called before recording any operations.
   */
  async initialize(): Promise<void> {
    if (!this.enabled) {
      logDebug("History recording disabled, skipping initialization");
      return;
    }

    // Database mode: session already created in database, skip file initialization
    if (this.db && this.dbSessionId !== undefined) {
      logDebug(`History session initialized in database mode: ${this.sessionId}`);
      return;
    }

    // Legacy mode: create JSONL file with header
    const historyDir = dirname(this.filePath);
    await mkdir(historyDir, { recursive: true });

    const header: HistorySessionHeader = {
      _header: true,
      version: HISTORY_VERSION,
      command: this.command,
      startedAt: new Date().toISOString(),
      status: "pending",
      cwd: process.cwd(),
    };

    await writeFile(this.filePath, JSON.stringify(header) + "\n", "utf-8");
    logDebug(`Created history session: ${this.sessionId}`);
  }

  /**
   * Records a copy operation.
   *
   * @param src - Source file path
   * @param dest - Destination file path
   */
  async recordCopy(src: string, dest: string): Promise<void> {
    await this.recordEntry({
      op: "copy",
      at: new Date().toISOString(),
      src,
      dest,
    });
  }

  /**
   * Records a hardlink operation.
   *
   * @param src - Source file path
   * @param dest - Destination file path (the link)
   */
  async recordHardlink(src: string, dest: string): Promise<void> {
    await this.recordEntry({
      op: "hardlink",
      at: new Date().toISOString(),
      src,
      dest,
    });
  }

  /**
   * Records a file conversion operation.
   *
   * @param src - Source file path
   * @param dest - Destination file path (converted file)
   * @param format - Target audio format
   */
  async recordConvert(src: string, dest: string, format: ConvertFormat): Promise<void> {
    await this.recordEntry({
      op: "convert",
      at: new Date().toISOString(),
      src,
      dest,
      fmt: format,
    });
  }

  /**
   * Records a directory creation operation.
   *
   * @param path - Directory path
   * @param wasCreated - True if directory was actually created (didn't exist)
   */
  async recordMkdir(path: string, wasCreated: boolean): Promise<void> {
    await this.recordEntry({
      op: "mkdir",
      at: new Date().toISOString(),
      dest: path,
      created: wasCreated,
    });
  }

  /**
   * Records a file/directory removal operation.
   *
   * @param path - Path that was removed
   */
  async recordRemove(path: string): Promise<void> {
    await this.recordEntry({
      op: "remove",
      at: new Date().toISOString(),
      dest: path,
    });
  }

  /**
   * Records a file/directory trash operation.
   *
   * @param path - Path that was moved to trash
   */
  async recordTrash(path: string): Promise<void> {
    await this.recordEntry({
      op: "trash",
      at: new Date().toISOString(),
      dest: path,
    });
  }

  /**
   * Records a generic operation entry (routes to database or file).
   *
   * @param entry - History entry to record
   */
  private async recordEntry(entry: HistoryEntry): Promise<void> {
    if (!this.enabled || this.closed) {
      return;
    }

    try {
      // Database mode: route to database
      if (this.db && this.dbSessionId !== undefined) {
        this.recordEntryToDb(entry);
        this.operationCount++;
        return;
      }

      // Legacy mode: append to JSONL file
      await appendFile(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
      this.operationCount++;
    } catch (err) {
      const error = err as Error;
      logWarn(`Failed to record history entry: ${error.message}`);
    }
  }

  /**
   * Records an entry to the database (database mode only).
   *
   * @param entry - History entry to record
   */
  private recordEntryToDb(entry: HistoryEntry): void {
    if (!this.db || this.dbSessionId === undefined) {
      throw new Error("Database mode not initialized");
    }

    const params: RecordHistoryOperationParams = {
      sessionId: this.dbSessionId,
      operationType: entry.op,
      occurredAt: entry.at,
      destPath: "dest" in entry ? entry.dest : "",
    };

    // Add operation-specific fields
    if ("src" in entry) params.sourcePath = entry.src;
    if ("fmt" in entry) params.convertFormat = entry.fmt;
    if ("created" in entry) params.createdDir = entry.created;

    recordHistoryOperation(this.db, params);
  }

  /**
   * Closes the session and updates the header/database with final metadata.
   */
  async close(): Promise<void> {
    if (!this.enabled || this.closed) {
      return;
    }

    this.closed = true;

    try {
      // Database mode: update session in database
      if (this.db && this.dbSessionId !== undefined) {
        closeHistorySessionInDb(
          this.db,
          this.dbSessionId,
          new Date().toISOString(),
          this.operationCount,
        );
        logDebug(
          `Closed history session in database: ${this.sessionId} (${this.operationCount} operations)`,
        );
        return;
      }

      // Legacy mode: update JSONL file header
      const content = await readFile(this.filePath, "utf-8");
      const lines = content.split("\n").filter((line) => line.trim() !== "");

      if (lines.length === 0) {
        logWarn("History session has no entries, removing empty file");
        await remove(this.filePath);
        return;
      }

      const firstLine = lines[0];
      if (!firstLine) {
        return;
      }

      const header = JSON.parse(firstLine) as HistorySessionHeader;
      header.endedAt = new Date().toISOString();
      header.operationCount = this.operationCount;

      lines[0] = JSON.stringify(header);
      await writeFile(this.filePath, lines.join("\n") + "\n", "utf-8");

      logDebug(`Closed history session: ${this.sessionId} (${this.operationCount} operations)`);
    } catch (err) {
      const error = err as Error;
      logWarn(`Failed to close history session: ${error.message}`);
    }
  }

  /**
   * Returns the number of operations recorded so far.
   */
  getOperationCount(): number {
    return this.operationCount;
  }
}

/**
 * Creates and initializes a new history session.
 *
 * @param command - Command name being executed
 * @param db - Optional database connection (enables database mode)
 * @returns Initialized history recorder
 */
export async function createHistorySession(
  command: string,
  db?: DbConnection,
): Promise<HistoryRecorder> {
  let dbSessionId: number | undefined;

  // Database mode: create session record in database first
  if (db) {
    const sessionId = generateSessionId(command);
    dbSessionId = createHistorySessionInDb(db, {
      sessionId,
      version: HISTORY_VERSION,
      command,
      startedAt: new Date().toISOString(),
      cwd: process.cwd(),
    });
  }

  const recorder = new HistoryRecorder(command, { db, dbSessionId });
  await recorder.initialize();
  return recorder;
}

/**
 * Converts a database history operation to a HistoryEntry.
 *
 * @param dbOp - Database operation record
 * @returns History entry
 */
function convertDbOperationToEntry(dbOp: DbHistoryOperation): HistoryEntry {
  switch (dbOp.operation_type) {
    case "copy":
      return {
        op: "copy",
        at: dbOp.occurred_at,
        src: dbOp.source_path!,
        dest: dbOp.dest_path,
      };
    case "hardlink":
      return {
        op: "hardlink",
        at: dbOp.occurred_at,
        src: dbOp.source_path!,
        dest: dbOp.dest_path,
      };
    case "convert":
      return {
        op: "convert",
        at: dbOp.occurred_at,
        src: dbOp.source_path!,
        dest: dbOp.dest_path,
        fmt: dbOp.convert_format! as ConvertFormat,
      };
    case "mkdir":
      return {
        op: "mkdir",
        at: dbOp.occurred_at,
        dest: dbOp.dest_path,
        created: dbOp.created_dir === 1,
      };
    case "remove":
      return {
        op: "remove",
        at: dbOp.occurred_at,
        dest: dbOp.dest_path,
      };
    case "trash":
      return {
        op: "trash",
        at: dbOp.occurred_at,
        dest: dbOp.dest_path,
      };
  }
}

/**
 * Lists sessions from database.
 *
 * @param db - Database connection
 * @param options - Filter and limit options
 * @returns Array of session info objects (header + metadata)
 */
function listSessionsFromDb(db: DbConnection, options?: ListSessionsOptions): HistorySession[] {
  const filter: HistorySessionFilter = {
    status: options?.status,
    command: options?.command,
    limit: options?.limit,
  };

  const dbSessions = getHistorySessions(db, filter);

  return dbSessions.map((dbSession) => ({
    id: dbSession.session_id,
    header: {
      _header: true,
      version: dbSession.version,
      command: dbSession.command,
      startedAt: dbSession.started_at,
      endedAt: dbSession.ended_at ?? undefined,
      status: dbSession.status,
      cwd: dbSession.cwd,
      operationCount: dbSession.operation_count,
    },
    entries: [],
    dbSessionId: dbSession.id,
  }));
}

/**
 * Lists available history sessions (dual-mode: database or files).
 *
 * @param options - Filter and limit options
 * @param db - Optional database connection (enables database mode)
 * @returns Array of session info objects (header + metadata)
 */
export async function listSessions(
  options?: ListSessionsOptions,
  db?: DbConnection,
): Promise<HistorySession[]> {
  // Route to database mode
  if (db) {
    return listSessionsFromDb(db, options);
  }

  // Legacy file-based mode (existing implementation)
  const historyDir = getHistoryDir();

  if (!(await pathExists(historyDir))) {
    return [];
  }

  // Read all .jsonl files from history directory
  const entries = await readdir(historyDir, { withFileTypes: true });
  const sessionFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name)
    .sort()
    .reverse(); // Most recent first

  const sessions: HistorySession[] = [];

  for (const filename of sessionFiles) {
    const filePath = join(historyDir, filename);
    const sessionId = extractSessionId(filename);

    try {
      // Read only the header line
      const content = await readFile(filePath, "utf-8");
      const firstLine = content.split("\n")[0];
      if (!firstLine) continue;

      const header = JSON.parse(firstLine) as HistorySessionHeader;

      // Skip if not a valid header
      if (!header._header) continue;

      // Apply filters
      if (options?.status && header.status !== options.status) continue;
      if (options?.command && header.command !== options.command) continue;

      sessions.push({
        id: sessionId,
        filePath,
        header,
        entries: [], // Not loaded - use loadSession for full entries
      });

      // Apply limit
      if (options?.limit && sessions.length >= options.limit) break;
    } catch {
      // Skip malformed files
      logDebug(`Skipping malformed history file: ${filename}`);
    }
  }

  return sessions;
}

/**
 * Loads a session from database with all operations.
 *
 * @param db - Database connection
 * @param sessionIdStr - Session ID string
 * @returns Complete session object with entries
 * @throws Error if session not found
 */
function loadSessionFromDb(db: DbConnection, sessionIdStr: string): HistorySession {
  const dbSession = findHistorySession(db, sessionIdStr);
  if (!dbSession) {
    throw new Error(`Session not found: ${sessionIdStr}`);
  }

  // Load operations and convert to HistoryEntry format
  const dbOperations = getHistoryOperations(db, dbSession.id);
  const entries: HistoryEntry[] = dbOperations.map(convertDbOperationToEntry);

  return {
    id: dbSession.session_id,
    header: {
      _header: true,
      version: dbSession.version,
      command: dbSession.command,
      startedAt: dbSession.started_at,
      endedAt: dbSession.ended_at ?? undefined,
      status: dbSession.status,
      cwd: dbSession.cwd,
      operationCount: dbSession.operation_count,
    },
    entries,
    dbSessionId: dbSession.id,
  };
}

/**
 * Fully loads a session with all entries (dual-mode: database or files).
 *
 * @param sessionId - Session ID to load
 * @param db - Optional database connection (enables database mode)
 * @returns Complete session object with entries
 * @throws Error if session not found or malformed
 */
export async function loadSession(sessionId: string, db?: DbConnection): Promise<HistorySession> {
  // Route to database mode
  if (db) {
    return loadSessionFromDb(db, sessionId);
  }

  // Legacy file-based mode (existing implementation)
  const filePath = getSessionFilePath(sessionId);

  if (!(await pathExists(filePath))) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim() !== "");

  if (lines.length === 0) {
    throw new Error(`Session file is empty: ${sessionId}`);
  }

  const firstLine = lines[0];
  if (!firstLine) {
    throw new Error(`Session file has no header: ${sessionId}`);
  }

  const header = JSON.parse(firstLine) as HistorySessionHeader;

  if (!header._header) {
    throw new Error(`Invalid session header: ${sessionId}`);
  }

  // Parse all entry lines (skip header)
  const entries: HistoryEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    try {
      const entry = JSON.parse(line) as HistoryEntry;
      entries.push(entry);
    } catch {
      logWarn(`Skipping malformed entry in session ${sessionId} at line ${i + 1}`);
    }
  }

  return {
    id: sessionId,
    filePath,
    header,
    entries,
  };
}

/**
 * Updates the status of a session (dual-mode: database or files).
 *
 * @param sessionId - Session ID to update
 * @param status - New status
 * @param db - Optional database connection (enables database mode)
 */
export async function updateSessionStatus(
  sessionId: string,
  status: SessionStatus,
  db?: DbConnection,
): Promise<void> {
  // Route to database mode
  if (db) {
    updateHistorySessionStatusInDb(db, sessionId, status);
    return;
  }

  // Legacy file-based mode (existing implementation)
  const filePath = getSessionFilePath(sessionId);

  if (!(await pathExists(filePath))) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim() !== "");

  if (lines.length === 0) return;

  const firstLine = lines[0];
  if (!firstLine) return;

  const header = JSON.parse(firstLine) as HistorySessionHeader;
  header.status = status;

  lines[0] = JSON.stringify(header);
  await writeFile(filePath, lines.join("\n") + "\n", "utf-8");

  logDebug(`Updated session ${sessionId} status to: ${status}`);
}

export interface LegacyHistoryMigrationFailure {
  filePath: string;
  error: string;
}

export interface LegacyHistoryMigrationResult {
  sessions: number;
  operations: number;
  importedFiles: string[];
  alreadyEquivalentFiles: string[];
  failedFiles: LegacyHistoryMigrationFailure[];
}

interface ValidatedLegacySession {
  header: HistorySessionHeader;
  entries: HistoryEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }

  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function validateLegacyEntry(value: unknown, lineNumber: number): HistoryEntry {
  if (!isRecord(value)) {
    throw new Error(`Invalid history entry at line ${lineNumber}`);
  }

  const at = value["at"];
  if (!isIsoTimestamp(at)) {
    throw new Error(`Invalid history entry timestamp at line ${lineNumber}`);
  }

  const op = value["op"];
  const dest = requireString(value["dest"], `history entry destination at line ${lineNumber}`);

  switch (op) {
    case "copy":
    case "hardlink":
      return {
        op,
        at,
        src: requireString(value["src"], `history entry source at line ${lineNumber}`),
        dest,
      };
    case "convert": {
      const fmt = value["fmt"];
      if (fmt !== "alac" && fmt !== "mp3" && fmt !== "aac" && fmt !== "opus") {
        throw new Error(`Invalid history entry format at line ${lineNumber}`);
      }
      return {
        op,
        at,
        src: requireString(value["src"], `history entry source at line ${lineNumber}`),
        dest,
        fmt,
      };
    }
    case "mkdir": {
      const created = value["created"];
      if (typeof created !== "boolean") {
        throw new Error(`Invalid history entry created flag at line ${lineNumber}`);
      }
      return { op, at, dest, created };
    }
    case "remove":
    case "trash":
      return { op, at, dest };
    default:
      throw new Error(`Invalid history entry operation at line ${lineNumber}`);
  }
}

function validateLegacySession(content: string): ValidatedLegacySession {
  const lines = content.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    throw new Error("History session is empty");
  }

  let headerValue: unknown;
  try {
    headerValue = JSON.parse(lines[0] as string) as unknown;
  } catch {
    throw new Error("Invalid history session header JSON");
  }

  if (!isRecord(headerValue) || headerValue["_header"] !== true) {
    throw new Error("Invalid history session header");
  }

  const status = headerValue["status"];
  if (status !== "pending" && status !== "undone" && status !== "partial") {
    throw new Error("Invalid history session status");
  }

  const startedAt = headerValue["startedAt"];
  const endedAt = headerValue["endedAt"];
  if (!isIsoTimestamp(startedAt) || !isIsoTimestamp(endedAt)) {
    throw new Error("History session is incomplete");
  }

  const operationCount = headerValue["operationCount"];
  if (!Number.isSafeInteger(operationCount) || (operationCount as number) < 0) {
    throw new Error("Invalid history session operation count");
  }

  const entries: HistoryEntry[] = [];
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index] as string;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Invalid history entry JSON at line ${index + 1}`);
    }
    entries.push(validateLegacyEntry(value, index + 1));
  }

  if (operationCount !== entries.length) {
    throw new Error(
      `History session operation count mismatch: expected ${String(operationCount)}, found ${entries.length}`,
    );
  }

  return {
    header: {
      _header: true,
      version: requireString(headerValue["version"], "history session version"),
      command: requireString(headerValue["command"], "history session command"),
      startedAt,
      endedAt,
      status,
      cwd: requireString(headerValue["cwd"], "history session working directory"),
      operationCount,
    },
    entries,
  };
}

function toHistoryOperationParams(
  sessionId: number,
  entry: HistoryEntry,
): RecordHistoryOperationParams {
  const params: RecordHistoryOperationParams = {
    sessionId,
    operationType: entry.op,
    occurredAt: entry.at,
    destPath: entry.dest,
  };

  if ("src" in entry) params.sourcePath = entry.src;
  if ("fmt" in entry) params.convertFormat = entry.fmt;
  if ("created" in entry) params.createdDir = entry.created;
  return params;
}

function isEquivalentHistorySession(
  db: DbConnection,
  sessionId: string,
  session: ValidatedLegacySession,
): boolean {
  const existing = findHistorySession(db, sessionId);
  if (!existing) return false;

  const { header, entries } = session;
  if (
    existing.version !== header.version ||
    existing.command !== header.command ||
    existing.started_at !== header.startedAt ||
    existing.ended_at !== header.endedAt ||
    existing.status !== header.status ||
    existing.cwd !== header.cwd ||
    existing.operation_count !== header.operationCount
  ) {
    return false;
  }

  const storedEntries = getHistoryOperations(db, existing.id).map(convertDbOperationToEntry);
  return JSON.stringify(storedEntries) === JSON.stringify(entries);
}

/**
 * Migrates all legacy JSONL history files to the database.
 *
 * @param db - Database connection
 * @param historyDir - Resolved legacy history directory (defaults to configured directory)
 * @returns Migration statistics (sessions and operations migrated)
 */
export async function migrateLegacyHistory(
  db: DbConnection,
  historyDir: string = getHistoryDir(),
): Promise<LegacyHistoryMigrationResult> {
  const result: LegacyHistoryMigrationResult = {
    sessions: 0,
    operations: 0,
    importedFiles: [],
    alreadyEquivalentFiles: [],
    failedFiles: [],
  };

  if (!(await pathExists(historyDir))) {
    return result;
  }

  const entries = await readdir(historyDir, { withFileTypes: true });
  const sessionFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name)
    .sort();

  for (const filename of sessionFiles) {
    const sessionId = extractSessionId(filename);
    const filePath = join(historyDir, filename);
    try {
      const session = validateLegacySession(await readFile(filePath, "utf-8"));
      const existing = findHistorySession(db, sessionId);
      if (existing) {
        if (isEquivalentHistorySession(db, sessionId, session)) {
          result.alreadyEquivalentFiles.push(filePath);
        } else {
          throw new Error(`Database session conflicts with legacy history: ${sessionId}`);
        }
        continue;
      }

      const importSession = db.transaction(() => {
        const dbSessionId = createHistorySessionInDb(db, {
          sessionId,
          version: session.header.version,
          command: session.header.command,
          startedAt: session.header.startedAt,
          cwd: session.header.cwd,
        });

        for (const entry of session.entries) {
          recordHistoryOperation(db, toHistoryOperationParams(dbSessionId, entry));
        }

        closeHistorySessionInDb(
          db,
          dbSessionId,
          session.header.endedAt as string,
          session.entries.length,
        );
        if (session.header.status !== "pending") {
          updateHistorySessionStatusInDb(db, sessionId, session.header.status);
        }

        if (!isEquivalentHistorySession(db, sessionId, session)) {
          throw new Error(`Imported history did not match legacy session: ${sessionId}`);
        }
      });

      importSession();
      if (!isEquivalentHistorySession(db, sessionId, session)) {
        db.prepare("DELETE FROM history_sessions WHERE session_id = ?").run(sessionId);
        throw new Error(`Durable history did not match legacy session: ${sessionId}`);
      }

      result.sessions++;
      result.operations += session.entries.length;
      result.importedFiles.push(filePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failedFiles.push({ filePath, error: message });
      logWarn(`Failed to migrate history file ${filename}: ${message}`);
    }
  }

  return result;
}

/**
 * Automatically migrates legacy history files if needed.
 * Called during database initialization to transparently upgrade from JSONL to database.
 *
 * @param db - Database connection
 * @returns True if migration was performed, false otherwise
 */
export async function autoMigrateHistoryIfNeeded(db: DbConnection): Promise<boolean> {
  const historyDir = getHistoryDir();

  if (!(await pathExists(historyDir))) {
    return false;
  }

  // Check for legacy JSONL files
  const entries = await readdir(historyDir, { withFileTypes: true });
  const hasLegacyFiles = entries.some((e) => e.isFile() && e.name.endsWith(".jsonl"));

  if (!hasLegacyFiles) {
    return false;
  }

  // Check if database already has sessions
  const existingSessions = getHistorySessions(db, { limit: 1 });
  if (existingSessions.length > 0) {
    return false; // Already migrated
  }

  logDebug("Detected legacy history files, running automatic migration...");
  const result = await migrateLegacyHistory(db);
  logDebug(
    `Migration complete: ${result.sessions} sessions, ${result.operations} operations migrated`,
  );
  return true;
}
