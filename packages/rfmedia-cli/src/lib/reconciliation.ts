/**
 * Pure three-plane metadata reconciliation.
 *
 * This module deliberately owns no acquisition or mutation. Callers provide
 * already bounded file, inventory, and server projections and receive a
 * deterministic report and requested-operation plan.
 */

import { isAbsolute, normalize, relative, resolve } from "node:path";

import type { DbReconciliationInventoryCandidate } from "../types/db.js";
import type { MediaServerNativeRatingScale, MediaTrack } from "../types/media-server.js";
import type {
  DatabaseStatOutcome,
  ReconciliationBlocker,
  ReconciliationFailureCode,
  ReconciliationField,
  ReconciliationFinding,
  ReconciliationPlane,
  ReconciliationPostApply,
  ReconciliationStrategy,
  ReconciliationTargetOutcome,
  ReconciliationValue,
} from "../types/reconciliation.js";

const PLANES = ["file", "database", "server"] as const;
const FIELDS = ["rating", "artist", "genre", "year"] as const;
const MIN_MEDIA_YEAR = 1000;
const MAX_MEDIA_YEAR = 9999;

/** Metadata projected from one checked local file. */
export type ReconciliationFileMetadataInput =
  | {
      readonly state: "present";
      readonly rating: number | null;
      readonly artist: string | null;
      readonly genre: string | null;
      readonly year: number | null;
    }
  | {
      readonly state: "failed";
    };

/** Selected file-rating encoding used to project read-after-write values. */
export type ReconciliationFileRatingWriteProjection =
  | {
      readonly encoding: "mp3-popm";
    }
  | {
      readonly encoding: "unsupported";
    };

/** Checked local-file evidence accepted by the pure engine. */
export interface ReconciliationFileInput {
  readonly path: string;
  readonly metadata: ReconciliationFileMetadataInput;
  readonly stat: {
    readonly mtime: number;
    readonly size: number;
  };
  /** Exact read-after-write projection selected for this file and invocation. */
  readonly ratingWriteProjection: ReconciliationFileRatingWriteProjection;
}

/** Complete immutable input for one pure reconciliation report. */
export interface BuildReconciliationReportInput {
  readonly sourceRoot: string;
  readonly files: readonly ReconciliationFileInput[];
  readonly databaseRows: readonly DbReconciliationInventoryCandidate[];
  readonly serverTracks: readonly MediaTrack[];
  readonly serverNativeRatingScale: MediaServerNativeRatingScale;
  readonly serverRatingWritable: boolean;
}

/** A finding with its stable identity exposed to presenters and tests. */
export interface ReconciliationEngineFinding extends ReconciliationFinding {
  readonly id: string;
}

/** Internal record retained in the report so planning does not reacquire data. */
export interface ReconciliationEngineRecord {
  readonly path: string;
  readonly file: ReconciliationFileInput | null;
  readonly databaseRows: readonly DbReconciliationInventoryCandidate[];
  readonly serverTracks: readonly MediaTrack[];
  readonly evidence: Readonly<Record<ReconciliationField, readonly ReconciliationValue[]>>;
}

/** Deterministic pure scan report. */
export interface ReconciliationEngineReport {
  readonly sourceRoot: string;
  readonly serverNativeRatingScale: MediaServerNativeRatingScale;
  readonly serverRatingWritable: boolean;
  readonly records: readonly ReconciliationEngineRecord[];
  readonly findings: readonly ReconciliationEngineFinding[];
  readonly observedResiduals: readonly ReconciliationEngineFinding[];
}

/** Boolean winner flags accepted by Commander and direct action callers. */
export interface ReconciliationStrategyFlags {
  readonly fileWins?: boolean;
  readonly dbWins?: boolean;
  readonly serverWins?: boolean;
}

/** Pure preview plan for requested rating and database-stat work. */
export interface ReconciliationEnginePlan {
  readonly strategy: ReconciliationStrategy;
  readonly allowPartial: boolean;
  readonly executable: boolean;
  readonly incomplete: boolean;
  readonly actionablePaths: readonly string[];
  readonly blockers: readonly ReconciliationBlocker[];
  readonly outcomes: readonly ReconciliationTargetOutcome[];
}

/** Inputs to the aggregate status reducer used after preview or execution. */
export interface ReconciliationStatusInput {
  readonly mode: "scan" | "apply";
  readonly executed: boolean;
  readonly executable: boolean;
  readonly declined?: boolean;
  readonly blockers?: readonly ReconciliationBlocker[];
  readonly outcomes?: readonly ReconciliationTargetOutcome[];
  readonly failureCodes?: readonly ReconciliationFailureCode[];
  readonly postApply?: ReconciliationPostApply | null;
}

/** Closed aggregate status tuple. */
export interface ReconciliationStatusResult {
  readonly status:
    | "scanned"
    | "preview"
    | "declined"
    | "blocked"
    | "applied"
    | "partial"
    | "failed"
    | "cancelled";
  readonly success: boolean;
  readonly exitCode: 0 | 1 | 130;
}

/**
 * Lexically normalizes an absolute candidate and proves it is contained by an
 * absolute source root. Case and basename are never used as identity.
 */
export function normalizeReconciliationPath(sourceRoot: string, candidate: string): string | null {
  if (
    !sourceRoot.trim() ||
    !candidate.trim() ||
    !isAbsolute(sourceRoot) ||
    !isAbsolute(candidate)
  ) {
    return null;
  }

  const root = normalize(resolve(sourceRoot));
  const path = normalize(resolve(candidate));
  const fromRoot = relative(root, path);
  if (fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))) {
    return path;
  }
  return null;
}

/**
 * Returns whether two normalized ratings occupy the same server-native step.
 * Invalid scale metadata falls back to exact normalized equality.
 */
export function ratingsShareNativeStep(
  left: number,
  right: number,
  scale: MediaServerNativeRatingScale,
): boolean {
  const span = scale.max - scale.min;
  if (!Number.isFinite(span) || span <= 0 || !Number.isFinite(scale.step) || scale.step <= 0) {
    return left === right;
  }
  const stepFor = (rating: number): number => Math.round((rating * span) / scale.step);
  return stepFor(left) === stepFor(right);
}

/**
 * Resolves exactly one winner flag to the closed strategy union.
 *
 * @throws RangeError when zero or multiple flags are selected.
 */
export function resolveReconciliationStrategy(
  flags: ReconciliationStrategyFlags,
): ReconciliationStrategy {
  const selected = [
    flags.fileWins ? "file-wins" : null,
    flags.dbWins ? "db-wins" : null,
    flags.serverWins ? "server-wins" : null,
  ].filter((value): value is ReconciliationStrategy => value !== null);
  if (selected.length !== 1) {
    throw new RangeError("Exactly one of --file-wins, --db-wins, or --server-wins is required.");
  }
  return selected[0]!;
}

function observation(
  plane: ReconciliationPlane,
  field: ReconciliationField,
  raw: string | number | null | undefined,
  failed = false,
): ReconciliationValue {
  if (failed) return { plane, state: "failed", value: null };
  if (raw === undefined) return { plane, state: "unavailable", value: null };
  if (raw === null) return { plane, state: "missing", value: null };

  if (field === "rating") {
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1
      ? { plane, state: "present", value: raw }
      : { plane, state: "invalid", value: raw };
  }
  if (field === "year") {
    return typeof raw === "number" &&
      Number.isSafeInteger(raw) &&
      raw >= MIN_MEDIA_YEAR &&
      raw <= MAX_MEDIA_YEAR
      ? { plane, state: "present", value: raw }
      : { plane, state: "invalid", value: raw };
  }
  return typeof raw === "string" && raw.normalize("NFC").trim().length > 0
    ? { plane, state: "present", value: raw }
    : { plane, state: "invalid", value: raw };
}

function comparisonKey(field: ReconciliationField, value: string | number): string | number {
  return field === "artist" || field === "genre"
    ? String(value).normalize("NFC").trim().toLowerCase()
    : value;
}

function presentValuesAgree(
  field: ReconciliationField,
  evidence: readonly ReconciliationValue[],
  scale: MediaServerNativeRatingScale,
): boolean {
  const present = evidence.filter(
    (value): value is Extract<ReconciliationValue, { state: "present" }> =>
      value.state === "present",
  );
  for (let leftIndex = 0; leftIndex < present.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < present.length; rightIndex += 1) {
      const left = present[leftIndex]!;
      const right = present[rightIndex]!;
      if (
        field === "rating" &&
        (left.plane === "server" || right.plane === "server") &&
        typeof left.value === "number" &&
        typeof right.value === "number"
      ) {
        if (!ratingsShareNativeStep(left.value, right.value, scale)) return false;
      } else if (comparisonKey(field, left.value) !== comparisonKey(field, right.value)) {
        return false;
      }
    }
  }
  return true;
}

function findingId(
  path: string,
  field: ReconciliationField | null,
  code: ReconciliationFinding["code"],
  operationIds: readonly number[],
  serverTrackIds: readonly string[],
): string {
  return [path, field ?? "path", code, operationIds.join(","), serverTrackIds.join(",")]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

function makeFinding(
  path: string,
  field: ReconciliationField | null,
  code: ReconciliationFinding["code"],
  evidence: readonly ReconciliationValue[],
  operationIds: readonly number[],
  serverTrackIds: readonly string[],
  repairable: boolean,
): ReconciliationEngineFinding {
  return {
    id: findingId(path, field, code, operationIds, serverTrackIds),
    path,
    field,
    code,
    evidence,
    operationIds,
    serverTrackIds,
    repairable,
  };
}

function fieldFindingCode(
  evidence: readonly ReconciliationValue[],
  scale: MediaServerNativeRatingScale,
  field: ReconciliationField,
): ReconciliationFinding["code"] {
  if (evidence.some((value) => value.state === "failed")) return "read-failed";
  if (evidence.some((value) => value.state === "invalid")) return "read-failed";
  if (evidence.some((value) => value.state !== "present")) return "missing-value";
  return presentValuesAgree(field, evidence, scale) ? "in-sync" : "conflicting-value";
}

function compareFindings(
  left: ReconciliationEngineFinding,
  right: ReconciliationEngineFinding,
): number {
  const pathOrder = left.path.localeCompare(right.path);
  if (pathOrder !== 0) return pathOrder;
  const leftField = left.field === null ? -1 : FIELDS.indexOf(left.field);
  const rightField = right.field === null ? -1 : FIELDS.indexOf(right.field);
  if (leftField !== rightField) return leftField - rightField;
  const codeOrder = left.code.localeCompare(right.code);
  return codeOrder !== 0 ? codeOrder : left.id.localeCompare(right.id);
}

/**
 * Builds a deterministic exact-path report without reading or writing any
 * external state.
 */
export function buildReconciliationReport(
  input: BuildReconciliationReportInput,
): ReconciliationEngineReport {
  const sourceRoot = normalizeReconciliationPath(input.sourceRoot, input.sourceRoot);
  if (sourceRoot === null) throw new TypeError("Reconciliation source root must be absolute.");

  const files = new Map<string, ReconciliationFileInput>();
  for (const file of input.files) {
    const path = normalizeReconciliationPath(sourceRoot, file.path);
    if (path !== null) files.set(path, { ...file, path });
  }

  const databaseRows = new Map<string, DbReconciliationInventoryCandidate[]>();
  for (const row of input.databaseRows) {
    const path = normalizeReconciliationPath(sourceRoot, row.dest_path);
    if (path === null) continue;
    const rows = databaseRows.get(path) ?? [];
    rows.push(row);
    databaseRows.set(path, rows);
  }

  const serverTracks = new Map<string, MediaTrack[]>();
  for (const track of input.serverTracks) {
    const path = normalizeReconciliationPath(sourceRoot, track.filePath);
    if (path === null) continue;
    const tracks = serverTracks.get(path) ?? [];
    tracks.push(track);
    serverTracks.set(path, tracks);
  }

  const paths = [
    ...new Set([...files.keys(), ...databaseRows.keys(), ...serverTracks.keys()]),
  ].sort((left, right) => left.localeCompare(right));
  const records: ReconciliationEngineRecord[] = [];
  const findings: ReconciliationEngineFinding[] = [];

  for (const path of paths) {
    const file = files.get(path) ?? null;
    const rows = [...(databaseRows.get(path) ?? [])].sort(
      (left, right) => left.operation_id - right.operation_id || left.id - right.id,
    );
    const tracks = [...(serverTracks.get(path) ?? [])].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const operationIds = rows.map((row) => row.operation_id);
    const serverTrackIds = tracks.map((track) => track.id);

    if (rows.length > 1) {
      findings.push(
        makeFinding(
          path,
          null,
          "ambiguous-database-entry",
          [],
          operationIds,
          serverTrackIds,
          false,
        ),
      );
    } else if (rows.length === 0) {
      findings.push(
        makeFinding(path, null, "missing-database-entry", [], [], serverTrackIds, false),
      );
    }
    if (tracks.length > 1) {
      findings.push(
        makeFinding(path, null, "ambiguous-server-path", [], operationIds, serverTrackIds, false),
      );
    } else if (tracks.length === 0) {
      findings.push(makeFinding(path, null, "missing-server-track", [], operationIds, [], false));
    }

    const row = rows.length === 1 ? rows[0]! : null;
    const track = tracks.length === 1 ? tracks[0]! : null;
    if (
      row !== null &&
      (file === null || row.mtime !== file.stat.mtime || row.size !== file.stat.size)
    ) {
      findings.push(
        makeFinding(
          path,
          null,
          "stale-database-entry",
          [],
          operationIds,
          serverTrackIds,
          file !== null,
        ),
      );
    }

    const evidence = {} as Record<ReconciliationField, readonly ReconciliationValue[]>;
    for (const field of FIELDS) {
      const fileRaw =
        file?.metadata.state === "present"
          ? file.metadata[field]
          : file === null
            ? undefined
            : null;
      const dbRaw = row === null ? undefined : row[field];
      const serverRaw =
        track === null
          ? undefined
          : field === "genre"
            ? track.genres === undefined
              ? undefined
              : (track.genres[0] ?? null)
            : track[field];
      const values = [
        observation("file", field, fileRaw, file?.metadata.state === "failed"),
        observation("database", field, dbRaw),
        observation("server", field, serverRaw),
      ];
      evidence[field] = values;
      findings.push(
        makeFinding(
          path,
          field,
          fieldFindingCode(values, input.serverNativeRatingScale, field),
          values,
          operationIds,
          serverTrackIds,
          field === "rating" && rows.length <= 1 && tracks.length <= 1,
        ),
      );
    }
    records.push({ path, file, databaseRows: rows, serverTracks: tracks, evidence });
  }

  findings.sort(compareFindings);
  return {
    sourceRoot,
    serverNativeRatingScale: input.serverNativeRatingScale,
    serverRatingWritable: input.serverRatingWritable,
    records,
    findings,
    observedResiduals: findings.filter(
      (finding) =>
        finding.field !== null && finding.field !== "rating" && finding.code !== "in-sync",
    ),
  };
}

function strategyPlane(strategy: ReconciliationStrategy): ReconciliationPlane {
  switch (strategy) {
    case "file-wins":
      return "file";
    case "db-wins":
      return "database";
    case "server-wins":
      return "server";
  }
}

function blockerForAuthority(
  path: string,
  authority: ReconciliationPlane,
  value: ReconciliationValue,
): ReconciliationBlocker | null {
  if (value.state === "present") return null;
  const code =
    value.state === "missing"
      ? "missing-authority"
      : value.state === "unavailable"
        ? "unavailable-authority"
        : value.state === "invalid"
          ? "invalid-authority"
          : "read-failed";
  return { operation: "rating", path, field: "rating", authority, target: null, code };
}

function ratingWritable(
  report: ReconciliationEngineReport,
  record: ReconciliationEngineRecord,
  target: ReconciliationPlane,
): boolean {
  if (target === "database") return record.databaseRows.length === 1;
  if (target === "server") {
    return report.serverRatingWritable && record.serverTracks.length === 1;
  }
  if (record.file === null) return false;
  return record.file.ratingWriteProjection.encoding !== "unsupported";
}

function projectFileRating(
  projection: ReconciliationFileRatingWriteProjection,
  rating: number,
): number | null {
  if (projection.encoding === "unsupported" || rating <= 0) return null;

  const encoded = Math.round(rating * 254) + 1;
  const observed = (encoded - 1) / 254;
  return observed > 0 ? observed : null;
}

function fileAndDatabaseRatingsConflict(evidence: readonly ReconciliationValue[]): boolean {
  const file = evidence.find((value) => value.plane === "file");
  const database = evidence.find((value) => value.plane === "database");
  return (
    file?.state === "present" &&
    database?.state === "present" &&
    typeof file.value === "number" &&
    typeof database.value === "number" &&
    file.value !== database.value
  );
}

function compareOutcomes(
  left: ReconciliationTargetOutcome,
  right: ReconciliationTargetOutcome,
): number {
  const pathOrder = left.path.localeCompare(right.path);
  if (pathOrder !== 0) return pathOrder;
  const kindOrder = left.kind.localeCompare(right.kind);
  if (kindOrder !== 0) return kindOrder;
  if (left.kind === "rating" && right.kind === "rating") {
    return PLANES.indexOf(left.target) - PLANES.indexOf(right.target);
  }
  return 0;
}

/**
 * Plans only requested rating and database-stat targets. Non-rating residuals
 * never become outcomes or blockers.
 */
export function buildReconciliationPlan(
  report: ReconciliationEngineReport,
  strategy: ReconciliationStrategy,
  allowPartial = false,
): ReconciliationEnginePlan {
  const authority = strategyPlane(strategy);
  const blockers: ReconciliationBlocker[] = [];
  const outcomes: ReconciliationTargetOutcome[] = [];
  const blockedPaths = new Set<string>();

  for (const record of report.records) {
    const pathBlockers: ReconciliationBlocker[] = [];
    if (record.databaseRows.length > 1) {
      pathBlockers.push({
        operation: "rating",
        path: record.path,
        field: "rating",
        authority,
        target: authority === "database" ? null : "database",
        code: "ambiguous-database-entry",
      });
      pathBlockers.push({
        operation: "database-stat-refresh",
        path: record.path,
        field: null,
        target: "database",
        inventoryRowId: null,
        code: "ambiguous-database-entry",
      });
    }
    if (record.serverTracks.length > 1) {
      pathBlockers.push({
        operation: "rating",
        path: record.path,
        field: "rating",
        authority,
        target: authority === "server" ? null : "server",
        code: "ambiguous-server-path",
      });
    }

    const ratingEvidence = record.evidence.rating;
    const authorityValue = ratingEvidence.find((value) => value.plane === authority)!;
    const authorityBlocker = blockerForAuthority(record.path, authority, authorityValue);
    if (authorityBlocker !== null) pathBlockers.push(authorityBlocker);
    const requireExactServerConvergence =
      authority === "server" && fileAndDatabaseRatingsConflict(ratingEvidence);

    const recordOutcomes: ReconciliationTargetOutcome[] = [];
    if (authorityValue.state === "present" && typeof authorityValue.value === "number") {
      let projectionBlocked = false;
      for (const target of PLANES) {
        if (target === authority) continue;
        const targetValue = ratingEvidence.find((value) => value.plane === target)!;
        if (targetValue.state === "failed" || targetValue.state === "invalid") {
          pathBlockers.push({
            operation: "rating",
            path: record.path,
            field: "rating",
            authority,
            target,
            code: targetValue.state === "failed" ? "read-failed" : "stale-evidence",
          });
          continue;
        }
        const before =
          targetValue.state === "present" && typeof targetValue.value === "number"
            ? targetValue.value
            : null;
        let intended = authorityValue.value;
        if (target === "file") {
          const projected =
            record.file === null
              ? null
              : projectFileRating(record.file.ratingWriteProjection, authorityValue.value);
          const fileAlreadyEqual =
            before !== null &&
            (authority === "server" && !requireExactServerConvergence
              ? ratingsShareNativeStep(authorityValue.value, before, report.serverNativeRatingScale)
              : projected !== null && projected === before);
          if (fileAlreadyEqual) continue;
          if (projected === null) {
            pathBlockers.push({
              operation: "rating",
              path: record.path,
              field: "rating",
              authority,
              target: "file",
              code: "unsupported-target",
            });
            projectionBlocked = true;
            break;
          }
          intended = projected;
        }
        const equal =
          before !== null &&
          (target === "server" || (authority === "server" && !requireExactServerConvergence)
            ? ratingsShareNativeStep(intended, before, report.serverNativeRatingScale)
            : intended === before);
        if (equal) continue;
        if (!ratingWritable(report, record, target)) {
          pathBlockers.push({
            operation: "rating",
            path: record.path,
            field: "rating",
            authority,
            target,
            code: "unsupported-target",
          });
          continue;
        }
        recordOutcomes.push({
          kind: "rating",
          path: record.path,
          target,
          status: "planned",
          code: "planned",
          before,
          intended,
        });
      }
      if (projectionBlocked) recordOutcomes.length = 0;
    }

    const row = record.databaseRows.length === 1 ? record.databaseRows[0]! : null;
    if (row !== null) {
      if (record.file === null) {
        pathBlockers.push({
          operation: "database-stat-refresh",
          path: record.path,
          field: null,
          target: "database",
          inventoryRowId: row.id,
          code: "missing-destination",
        });
      } else if (row.mtime !== record.file.stat.mtime || row.size !== record.file.stat.size) {
        const statOutcome: DatabaseStatOutcome = {
          kind: "database-stat",
          path: record.path,
          target: "database",
          inventoryRowId: row.id,
          status: "planned",
          code: "planned",
          before: { mtime: row.mtime, size: row.size },
          intended: record.file.stat,
        };
        recordOutcomes.push(statOutcome);
      }
    }

    if (pathBlockers.length > 0) blockedPaths.add(record.path);
    blockers.push(...pathBlockers);
    if (!allowPartial || pathBlockers.length === 0) outcomes.push(...recordOutcomes);
  }

  blockers.sort((left, right) => {
    const pathOrder = left.path.localeCompare(right.path);
    if (pathOrder !== 0) return pathOrder;
    const operationOrder = left.operation.localeCompare(right.operation);
    return operationOrder !== 0 ? operationOrder : left.code.localeCompare(right.code);
  });
  outcomes.sort(compareOutcomes);
  const actionablePaths = [...new Set(outcomes.map((outcome) => outcome.path))].sort(
    (left, right) => left.localeCompare(right),
  );
  return {
    strategy,
    allowPartial,
    executable: blockers.length === 0 || (allowPartial && actionablePaths.length > 0),
    incomplete: blockers.length > 0,
    actionablePaths,
    blockers,
    outcomes,
  };
}

/**
 * Reduces scan, preview, and execution facts to the closed public status tuple.
 */
export function reduceReconciliationStatus(
  input: ReconciliationStatusInput,
): ReconciliationStatusResult {
  if (input.mode === "scan") return { status: "scanned", success: true, exitCode: 0 };
  if (!input.executed) return { status: "preview", success: true, exitCode: 0 };
  if (input.declined) return { status: "declined", success: false, exitCode: 1 };
  if (input.failureCodes?.includes("cancelled") || input.postApply?.status === "cancelled") {
    return { status: "cancelled", success: false, exitCode: 130 };
  }
  if (!input.executable) return { status: "blocked", success: false, exitCode: 1 };
  if (
    input.failureCodes?.length ||
    input.postApply?.status === "failed" ||
    input.outcomes?.some((outcome) => outcome.status === "failed")
  ) {
    const status = input.outcomes?.some((outcome) => outcome.status === "applied")
      ? "partial"
      : "failed";
    return { status, success: false, exitCode: 1 };
  }
  if (
    input.postApply?.status === "verified" &&
    (input.blockers?.length ?? 0) === 0 &&
    !input.outcomes?.some(
      (outcome) => outcome.status === "unsupported" || outcome.status === "planned",
    )
  ) {
    return { status: "applied", success: true, exitCode: 0 };
  }
  return { status: "partial", success: false, exitCode: 1 };
}
