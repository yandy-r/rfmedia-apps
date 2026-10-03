/**
 * Filesystem artifacts for rfapps state-database reconstruction.
 *
 * Path construction, the mandatory backup, and the atomic swap. Split out of
 * `state-rebuild.ts` to keep both modules inside the file-size cap; every symbol
 * here is re-exported from `./state-rebuild.js`, which stays the single entry
 * point for the reconstruction primitives.
 *
 * @module rfapps-cli/lib/state-rebuild-files
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { constants, rmSync } from "node:fs";
import { access, chmod, copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { logDebug } from "@rfmedia/common";

import type { StateBackupResult } from "../types/state-rebuild.js";

/**
 * Sidecar journal files that belong to a specific database file.
 *
 * `initializeDatabase()` never sets `journal_mode`, so this project runs in
 * SQLite's default `delete` mode and the sidecar it actually produces is
 * `<db>-journal`. `-wal` / `-shm` are listed too because an external tool (or a
 * future version) can switch a database to WAL, and a stale sidecar of either
 * kind is equally dangerous.
 */
const SIDECAR_SUFFIXES = ["-journal", "-wal", "-shm"] as const;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reserves the temp path for the replacement database.
 *
 * A SIBLING of the target, so `rename()` stays within one filesystem and is
 * therefore atomic.
 *
 * The name carries a random token rather than only `process.pid`, and any file
 * already sitting at the reserved path is removed before it is handed out.
 * `initializeDatabase(tempPath)` OPENS AN EXISTING FILE and runs
 * `CREATE TABLE IF NOT EXISTS`, so a leftover replacement from an earlier
 * crashed run would otherwise be adopted, layered with fresh carry-over rows,
 * and renamed over the operator's database.
 *
 * @param targetPath - Path the replacement will eventually take
 * @returns Hidden, unpredictable sibling path with nothing at it
 */
export function buildReplacementDatabasePath(targetPath: string): string {
  const path = join(
    dirname(targetPath),
    `.${basename(targetPath)}.rebuild-${process.pid}-${randomUUID()}.tmp`,
  );
  rmSync(path, { force: true });
  for (const suffix of SIDECAR_SUFFIXES) {
    rmSync(`${path}${suffix}`, { force: true });
  }
  return path;
}

/**
 * Builds the default backup destination for a state database.
 *
 * Pure function. Backups live beside the database rather than in cwd or /tmp
 * because they carry full deployment topology and config snapshots.
 *
 * @param dbPath - Resolved path to the state database
 * @param backupDir - Explicit directory override, when supplied
 * @param now - Clock reading used for the filename stamp
 * @returns e.g. `<state-dir>/backups/state-2026-07-24T18-15-00-000Z.db`
 */
export function defaultBackupPath(
  dbPath: string,
  backupDir: string | undefined,
  now: Date,
): string {
  const dir = backupDir ?? join(dirname(dbPath), "backups");
  const stamp = now.toISOString().replace(/[:.]/gu, "-");
  return join(dir, `state-${stamp}.db`);
}

/**
 * Copies journal siblings alongside a raw-copied database.
 *
 * The raw copy is the forensic fallback, and a database crashed mid-transaction
 * is worthless without its rollback journal: in this project's `delete` journal
 * mode that is `<db>-journal`.
 */
async function copySidecars(dbPath: string, destinationPath: string): Promise<string[]> {
  const sidecars: string[] = [];
  for (const suffix of SIDECAR_SUFFIXES) {
    const sidecarSource = `${dbPath}${suffix}`;
    if (!(await pathExists(sidecarSource))) {
      continue;
    }
    const sidecarDestination = `${destinationPath}${suffix}`;
    await copyFile(sidecarSource, sidecarDestination);
    await chmod(sidecarDestination, 0o600);
    sidecars.push(sidecarDestination);
  }
  return sidecars;
}

/**
 * Writes a restore-with-one-`cp` copy of the state database.
 *
 * The primary method is SQLite's online backup API, which is consistent under a
 * concurrent writer and journal-safe; a plain `copyFile` of a live database is
 * neither. The raw copy is therefore only the disaster fallback, used when
 * SQLite cannot even parse the source: the recovery path must not depend on the
 * happy path working, and forensic bytes are worth preserving.
 *
 * The artifact is mode 600 inside a mode 700 parent, and an existing
 * destination is never overwritten.
 *
 * @param dbPath - Source database to copy
 * @param destinationPath - Destination file (must not already exist)
 * @returns The artifact's path, method, size and any copied sidecars
 * @throws Error if the destination exists or both copy strategies fail
 */
export async function backupStateDatabase(
  dbPath: string,
  destinationPath: string,
): Promise<StateBackupResult> {
  await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });

  if (await pathExists(destinationPath)) {
    throw new Error(`Backup destination already exists: ${destinationPath}`);
  }

  try {
    const source = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      await source.backup(destinationPath);
    } finally {
      source.close();
    }
    await chmod(destinationPath, 0o600);
    const { size } = await stat(destinationPath);
    logDebug(`Wrote SQLite online backup of ${dbPath} to ${destinationPath}`);
    return { path: destinationPath, method: "sqlite-backup", bytes: size, sidecars: [] };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logDebug(`SQLite online backup failed (${reason}); falling back to a raw byte copy`);
  }

  await rm(destinationPath, { force: true });
  await copyFile(dbPath, destinationPath);
  await chmod(destinationPath, 0o600);
  const sidecars = await copySidecars(dbPath, destinationPath);
  const { size } = await stat(destinationPath);

  return { path: destinationPath, method: "raw-copy", bytes: size, sidecars };
}

/**
 * Moves a completed replacement over the existing state database.
 *
 * `rename()` within one directory is atomic, so the target is either the old
 * file or the new one and never a partial write. Any surviving sidecar belongs
 * to the file that was just replaced, and SQLite replays a hot rollback journal
 * (`<db>-journal`, this project's `delete`-mode sidecar) into whatever database
 * now carries that name — which would write the old file's pages over the fresh
 * one and corrupt it. Removal therefore happens immediately after the rename,
 * before anything can open the new file.
 *
 * @param tempPath - Sibling replacement produced by `initializeDatabase`
 * @param targetPath - Path being replaced
 * @throws Rethrows any failure after removing the temp file; the target is then
 *         byte-identical to before
 */
export async function swapStateDatabase(tempPath: string, targetPath: string): Promise<void> {
  try {
    await chmod(tempPath, 0o600);
    await rename(tempPath, targetPath);
    for (const suffix of SIDECAR_SUFFIXES) {
      await rm(`${targetPath}${suffix}`, { force: true });
    }
    logDebug(`Swapped rebuilt state database into ${targetPath}`);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}
