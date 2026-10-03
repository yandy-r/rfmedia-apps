import { isAbsolute, normalize, parse, sep } from "node:path";

import type {
  DbConnection,
  DbReconciliationInventoryCandidate,
  ReconciliationInventoryUpdate,
  ReconciliationInventoryUpdateResult,
} from "../../types/db.js";

export const RECONCILIATION_INVENTORY_MAX_CANDIDATES = 10_000;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

function assertFiniteNonNegativeNumber(value: unknown, field: string): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    Math.abs(value) > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(
      `Invalid inventory fingerprint: ${field} must be a finite non-negative number.`,
    );
  }
}

function assertNonNegativeSafeInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid inventory fingerprint: ${field} must be a non-negative safe integer.`);
  }
}

function assertPositiveSafeInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid inventory fingerprint: ${field} must be a positive safe integer.`);
  }
}

function assertNullableFiniteNumber(value: unknown, field: string): asserts value is number | null {
  if (
    value !== null &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      Math.abs(value) > Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error(`Invalid inventory fingerprint: ${field} must be null or a finite number.`);
  }
}

function assertNullableSafeInteger(value: unknown, field: string): asserts value is number | null {
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value))) {
    throw new Error(`Invalid inventory fingerprint: ${field} must be null or a safe integer.`);
  }
}

function assertNullableString(value: unknown, field: string): asserts value is string | null {
  if (value !== null && typeof value !== "string") {
    throw new Error(`Invalid inventory fingerprint: ${field} must be null or a string.`);
  }
}

function assertAbsoluteInventoryPath(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    !isAbsolute(value)
  ) {
    throw new Error(`Invalid inventory fingerprint: ${field} must be an absolute path.`);
  }
}

function assertRelativeInventoryPath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    isAbsolute(value) ||
    normalize(value) !== value ||
    value === "." ||
    value
      .split(/[\\/]/u)
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(
      "Invalid inventory fingerprint: relative_path must be a normalized relative path.",
    );
  }
}

function assertReconciliationInventoryCandidate(
  row: unknown,
): asserts row is DbReconciliationInventoryCandidate {
  if (typeof row !== "object" || row === null) {
    throw new Error("Invalid inventory fingerprint: candidate must be a database row.");
  }

  const candidate = row as Record<string, unknown>;
  assertPositiveSafeInteger(candidate["id"], "id");
  assertPositiveSafeInteger(candidate["operation_id"], "operation_id");
  assertAbsoluteInventoryPath(candidate["source_path"], "source_path");
  assertRelativeInventoryPath(candidate["relative_path"]);
  assertFiniteNonNegativeNumber(candidate["mtime"], "mtime");
  assertNonNegativeSafeInteger(candidate["size"], "size");
  assertNullableFiniteNumber(candidate["rating"], "rating");
  assertNullableString(candidate["genre"], "genre");
  assertNullableSafeInteger(candidate["year"], "year");
  assertNullableFiniteNumber(candidate["bpm"], "bpm");
  assertNullableString(candidate["artist"], "artist");
  assertAbsoluteInventoryPath(candidate["dest_path"], "dest_path");
  assertNullableString(candidate["content_hash"], "content_hash");
  assertFiniteNonNegativeNumber(candidate["copied_at"], "copied_at");
  if (normalize(candidate["dest_path"]) !== candidate["dest_path"]) {
    throw new Error(
      "Invalid reconciliation inventory candidate: dest_path must be a normalized absolute path.",
    );
  }
}

function normalizeReconciliationRoot(rootPath: string): string {
  if (
    typeof rootPath !== "string" ||
    rootPath.length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(rootPath) ||
    !isAbsolute(rootPath)
  ) {
    throw new Error("Reconciliation inventory root must be an absolute path.");
  }

  let normalizedRoot = normalize(rootPath);
  const filesystemRoot = parse(normalizedRoot).root;
  while (normalizedRoot.length > filesystemRoot.length && normalizedRoot.endsWith(sep)) {
    normalizedRoot = normalizedRoot.slice(0, -sep.length);
  }
  return normalizedRoot;
}

function validateReconciliationInventoryLimit(limit: number): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    limit > RECONCILIATION_INVENTORY_MAX_CANDIDATES
  ) {
    throw new Error(
      `Reconciliation inventory limit must be a positive safe integer no greater than ${RECONCILIATION_INVENTORY_MAX_CANDIDATES}.`,
    );
  }
}

export function getReconciliationInventoryCandidates(
  db: DbConnection,
  rootPath: string,
  operationId?: number,
  limit: number = RECONCILIATION_INVENTORY_MAX_CANDIDATES,
): DbReconciliationInventoryCandidate[] {
  const normalizedRoot = normalizeReconciliationRoot(rootPath);
  validateReconciliationInventoryLimit(limit);
  if (operationId !== undefined) assertPositiveSafeInteger(operationId, "operation_id");

  const filesystemRoot = parse(normalizedRoot).root;
  const rootPrefix = normalizedRoot === filesystemRoot ? normalizedRoot : `${normalizedRoot}${sep}`;
  const operationPredicate = operationId === undefined ? "" : "AND operation_id = ?";
  const rows = db
    .prepare(
      `
SELECT
  id, operation_id, source_path, relative_path, mtime, size, rating,
  genre, year, bpm, artist, dest_path, content_hash, copied_at
FROM inventory
WHERE (dest_path = ? OR substr(dest_path, 1, length(?)) = ?)
  ${operationPredicate}
ORDER BY dest_path ASC, operation_id ASC, id ASC
LIMIT ?
`,
    )
    .all(
      ...(operationId === undefined
        ? [normalizedRoot, rootPrefix, rootPrefix, limit + 1]
        : [normalizedRoot, rootPrefix, rootPrefix, operationId, limit + 1]),
    ) as unknown[];

  if (rows.length > limit) {
    throw new Error(`Reconciliation inventory query exceeds the ${limit}-row limit.`);
  }
  const candidates: DbReconciliationInventoryCandidate[] = [];
  for (const row of rows) {
    assertReconciliationInventoryCandidate(row);
    candidates.push(row);
  }
  return candidates;
}

export function getReconciliationInventoryCandidatesAtPath(
  db: DbConnection,
  destPath: string,
  operationId?: number,
): DbReconciliationInventoryCandidate[] {
  assertNormalizedAbsolutePath(destPath, "dest_path");
  if (operationId !== undefined) assertPositiveSafeInteger(operationId, "operation_id");

  const operationPredicate = operationId === undefined ? "" : "AND operation_id = ?";
  const rows = db
    .prepare(
      `
SELECT
  id, operation_id, source_path, relative_path, mtime, size, rating,
  genre, year, bpm, artist, dest_path, content_hash, copied_at
FROM inventory
WHERE dest_path = ?
  ${operationPredicate}
ORDER BY operation_id ASC, id ASC
LIMIT 2
`,
    )
    .all(...(operationId === undefined ? [destPath] : [destPath, operationId])) as unknown[];
  const candidates: DbReconciliationInventoryCandidate[] = [];
  for (const row of rows) {
    assertReconciliationInventoryCandidate(row);
    candidates.push(row);
  }
  return candidates;
}

function assertNormalizedAbsolutePath(value: unknown, field: string): asserts value is string {
  assertAbsoluteInventoryPath(value, field);
  if (normalize(value) !== value) {
    throw new Error(`Invalid reconciliation inventory update: ${field} must be normalized.`);
  }
}

function validateReconciliationInventoryUpdate(update: ReconciliationInventoryUpdate): void {
  assertPositiveSafeInteger(update.expected.rowId, "row_id");
  assertPositiveSafeInteger(update.expected.operationId, "operation_id");
  assertNormalizedAbsolutePath(update.expected.destPath, "dest_path");
  assertNullableFiniteNumber(update.expected.rating, "rating");
  assertFiniteNonNegativeNumber(update.expected.mtime, "mtime");
  assertNonNegativeSafeInteger(update.expected.size, "size");

  if (
    update.rating !== undefined &&
    (!Number.isFinite(update.rating) || update.rating < 0 || update.rating > 1)
  ) {
    throw new Error(
      "Invalid reconciliation inventory update: rating must be a finite number from 0 to 1.",
    );
  }
  if (
    update.stat !== undefined &&
    (!Number.isSafeInteger(update.stat.mtime) ||
      update.stat.mtime < 0 ||
      !Number.isSafeInteger(update.stat.size) ||
      update.stat.size < 0)
  ) {
    throw new Error(
      "Invalid reconciliation inventory update: stat mtime and size must be non-negative safe integers.",
    );
  }
}

export function updateReconciliationInventory(
  db: DbConnection,
  update: ReconciliationInventoryUpdate,
): ReconciliationInventoryUpdateResult {
  validateReconciliationInventoryUpdate(update);

  const assignments: string[] = [];
  const intendedValues: number[] = [];
  if (update.rating !== undefined) {
    assignments.push("rating = ?");
    intendedValues.push(update.rating);
  }
  if (update.stat !== undefined) {
    assignments.push("mtime = ?", "size = ?");
    intendedValues.push(update.stat.mtime, update.stat.size);
  }
  if (assignments.length === 0) {
    throw new Error("Reconciliation inventory update must include a rating or stat refresh.");
  }

  const statement = db.prepare(`
UPDATE inventory
SET ${assignments.join(", ")}
WHERE id = ?
  AND operation_id = ?
  AND dest_path = ?
  AND rating IS ?
  AND mtime = ?
  AND size = ?
`);
  return db.transaction((): ReconciliationInventoryUpdateResult => {
    const result = statement.run(
      ...intendedValues,
      update.expected.rowId,
      update.expected.operationId,
      update.expected.destPath,
      update.expected.rating,
      update.expected.mtime,
      update.expected.size,
    );
    if (result.changes === 0) {
      return { status: "stale-evidence", rowId: update.expected.rowId };
    }
    if (result.changes !== 1) {
      throw new Error(
        `Reconciliation inventory update invariant failed: expected one row, changed ${result.changes}.`,
      );
    }
    return { status: "updated", rowId: update.expected.rowId };
  })();
}
