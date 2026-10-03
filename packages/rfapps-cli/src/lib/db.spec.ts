import { beforeEach, describe, expect, it, vi } from "vitest";

const sqliteMocks = vi.hoisted(() => ({
  nextDb: undefined as unknown,
  constructor: vi.fn(function Database() {
    return sqliteMocks.nextDb;
  }),
}));

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFile: vi.fn(),
  mkdir: vi.fn(),
  access: vi.fn(),
  chmod: vi.fn(),
}));

const osMocks = vi.hoisted(() => ({
  homedir: vi.fn(() => "/home/test"),
}));

const migrationMocks = vi.hoisted(() => ({
  runMigrations: vi.fn(),
}));

const commonMocks = vi.hoisted(() => ({
  logDebug: vi.fn(),
}));

vi.mock("better-sqlite3", () => ({
  default: sqliteMocks.constructor,
}));
vi.mock("node:fs", () => ({
  existsSync: fsMocks.existsSync,
}));
vi.mock("node:fs/promises", () => ({
  readFile: fsMocks.readFile,
  mkdir: fsMocks.mkdir,
  access: fsMocks.access,
  constants: { F_OK: 0 },
  chmod: fsMocks.chmod,
}));
vi.mock("node:os", () => ({
  homedir: osMocks.homedir,
}));
vi.mock("./migrations.js", () => migrationMocks);
vi.mock("@rfmedia/common", () => commonMocks);

import {
  closeDatabase,
  getCurrentSchemaVersion,
  getDefaultDatabasePath,
  initializeDatabase,
  updateSchemaVersion,
} from "./db.js";

function createDb(row?: { value: string }) {
  const run = vi.fn();
  return {
    pragma: vi.fn(),
    exec: vi.fn(),
    close: vi.fn(),
    run,
    prepare: vi.fn(() => ({
      get: vi.fn(() => row),
      run,
    })),
  };
}

describe("database utilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.access.mockRejectedValue(new Error("missing"));
    fsMocks.readFile.mockResolvedValue("CREATE TABLE metadata(key text, value text);");
    fsMocks.mkdir.mockResolvedValue(undefined);
    fsMocks.chmod.mockResolvedValue(undefined);
    sqliteMocks.nextDb = createDb();
  });

  it("prefers XDG, then legacy, then XDG for default database paths", () => {
    fsMocks.existsSync.mockImplementation((path: string) => path === "/home/test/.config/rfapps");
    expect(getDefaultDatabasePath()).toBe("/home/test/.config/rfapps/state.db");

    fsMocks.existsSync.mockImplementation((path: string) => path === "/home/test/.rfapps");
    expect(getDefaultDatabasePath()).toBe("/home/test/.rfapps/state.db");

    fsMocks.existsSync.mockReturnValue(false);
    expect(getDefaultDatabasePath()).toBe("/home/test/.config/rfapps/state.db");
  });

  it("initializes new databases with schema, permissions, foreign keys, and migrations", async () => {
    const db = createDb();
    sqliteMocks.nextDb = db;

    await expect(initializeDatabase("/tmp/rfapps/state.db")).resolves.toBe(db);

    expect(fsMocks.mkdir).toHaveBeenCalledWith("/tmp/rfapps", { recursive: true, mode: 0o700 });
    expect(sqliteMocks.constructor).toHaveBeenCalledWith("/tmp/rfapps/state.db");
    expect(fsMocks.chmod).toHaveBeenCalledWith("/tmp/rfapps/state.db", 0o600);
    expect(db.pragma).toHaveBeenCalledWith("foreign_keys = ON");
    expect(db.exec).toHaveBeenCalledWith("CREATE TABLE metadata(key text, value text);");
    expect(migrationMocks.runMigrations).toHaveBeenCalledWith(db);
  });

  it("does not recreate existing directories or chmod existing databases", async () => {
    fsMocks.access.mockResolvedValue(undefined);
    const db = createDb();
    sqliteMocks.nextDb = db;

    await initializeDatabase("/tmp/rfapps/state.db");

    expect(fsMocks.mkdir).not.toHaveBeenCalled();
    expect(fsMocks.chmod).not.toHaveBeenCalled();
  });

  it("continues when chmod fails for a new database", async () => {
    fsMocks.chmod.mockRejectedValue(new Error("chmod failed"));
    const db = createDb();
    sqliteMocks.nextDb = db;

    await expect(initializeDatabase("/tmp/rfapps/state.db")).resolves.toBe(db);
    expect(commonMocks.logDebug).toHaveBeenCalledWith(
      expect.stringContaining("Could not set database permissions"),
    );
  });

  it("closes connections and reads schema version metadata", () => {
    const db = createDb({ value: "7" });

    expect(getCurrentSchemaVersion(db as never)).toBe(7);
    closeDatabase(db as never);
    expect(db.close).toHaveBeenCalled();

    const emptyDb = createDb(undefined);
    expect(getCurrentSchemaVersion(emptyDb as never)).toBe(0);
  });

  it("writes the schema version as a string via upsert", () => {
    const db = createDb();

    updateSchemaVersion(db as never, 2);

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("ON CONFLICT(key)"));
    expect(db.run).toHaveBeenCalledWith("2");
  });
});
