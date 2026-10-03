import type { DbReconciliationInventoryCandidate } from "../types/db.js";
import {
  MEDIA_IDENTITY_MAX_ID_BYTES,
  MEDIA_IDENTITY_MAX_TITLE_BYTES,
  type MediaTrack,
} from "../types/media-server.js";
import type { ReconciliationMetadata } from "./metadata.js";
import { MAX_SYNCHRONOUS_MP3_RATING_FILE_BYTES } from "./tag-writer.js";

/** Maximum retained provider projection for one reconciliation invocation. */
export const MAX_RECONCILIATION_SERVER_SNAPSHOT_BYTES = 64 * 1024 * 1024;
/** Maximum retained local projection for one reconciliation invocation. */
export const MAX_RECONCILIATION_LOCAL_SNAPSHOT_BYTES = 64 * 1024 * 1024;
/** Maximum UTF-8 bytes retained for one projected metadata value. */
export const MAX_RECONCILIATION_PROJECTED_TEXT_BYTES = MEDIA_IDENTITY_MAX_TITLE_BYTES;
/** Maximum UTF-8 bytes retained for one projected filesystem path. */
export const MAX_RECONCILIATION_PROJECTED_PATH_BYTES = 16 * 1024;
/** Maximum values retained from one projected provider tag family. */
export const MAX_RECONCILIATION_TAG_VALUES = 256;
/** Reconciliation uses the tag writer's synchronous whole-file MP3 ceiling. */
export const MAX_RECONCILIATION_MP3_RATING_FILE_BYTES = MAX_SYNCHRONOUS_MP3_RATING_FILE_BYTES;

type ReconciliationLimitReason =
  | "identifier-too-large"
  | "invalid-projection"
  | "path-too-large"
  | "snapshot-too-large"
  | "text-too-large"
  | "too-many-tags";

/** Internal validation result that never retains rejected input values. */
export type ReconciliationLimitResult =
  | {
      readonly ok: true;
      readonly bytes: number;
    }
  | {
      readonly ok: false;
      readonly reason: ReconciliationLimitReason;
    };

function failure(reason: ReconciliationLimitReason): ReconciliationLimitResult {
  return { ok: false, reason };
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function validateText(
  value: unknown,
  maximumBytes: number,
  tooLargeReason: ReconciliationLimitReason,
): ReconciliationLimitResult {
  if (typeof value !== "string") return failure("invalid-projection");
  const bytes = utf8Bytes(value);
  return bytes <= maximumBytes ? { ok: true, bytes } : failure(tooLargeReason);
}

function validateOptionalText(value: unknown): ReconciliationLimitResult {
  return value === null
    ? { ok: true, bytes: 0 }
    : validateText(value, MAX_RECONCILIATION_PROJECTED_TEXT_BYTES, "text-too-large");
}

function validatePath(value: unknown): ReconciliationLimitResult {
  return validateText(value, MAX_RECONCILIATION_PROJECTED_PATH_BYTES, "path-too-large");
}

function validateTags(value: unknown): ReconciliationLimitResult {
  if (value === undefined) return { ok: true, bytes: 0 };
  if (!Array.isArray(value)) return failure("invalid-projection");
  if (value.length > MAX_RECONCILIATION_TAG_VALUES) return failure("too-many-tags");

  let bytes = 0;
  for (const tag of value) {
    const result = validateText(tag, MAX_RECONCILIATION_PROJECTED_TEXT_BYTES, "text-too-large");
    if (!result.ok) return result;
    bytes += result.bytes;
  }
  return { ok: true, bytes };
}

function sumValidated(results: readonly ReconciliationLimitResult[]): ReconciliationLimitResult {
  let bytes = 0;
  for (const result of results) {
    if (!result.ok) return result;
    bytes += result.bytes;
  }
  return { ok: true, bytes };
}

/** Validates one checked local file projection before the action retains it. */
export function validateReconciliationLocalProjection(
  path: string,
  metadata: ReconciliationMetadata,
): ReconciliationLimitResult {
  return sumValidated([
    validatePath(path),
    validateOptionalText(metadata.artist),
    validateOptionalText(metadata.genre),
  ]);
}

/** Validates the text and paths retained from one reconciliation inventory row. */
export function validateReconciliationDatabaseProjection(
  row: DbReconciliationInventoryCandidate,
): ReconciliationLimitResult {
  return sumValidated([
    validatePath(row.source_path),
    validatePath(row.relative_path),
    validatePath(row.dest_path),
    validateOptionalText(row.artist),
    validateOptionalText(row.genre),
  ]);
}

/** Validates and measures one provider-neutral track projection. */
export function validateReconciliationServerTrack(track: MediaTrack): ReconciliationLimitResult {
  const fields = sumValidated([
    validateText(track.id, MEDIA_IDENTITY_MAX_ID_BYTES, "identifier-too-large"),
    validateText(track.title, MAX_RECONCILIATION_PROJECTED_TEXT_BYTES, "text-too-large"),
    validateText(track.artist, MAX_RECONCILIATION_PROJECTED_TEXT_BYTES, "text-too-large"),
    validateText(track.album, MAX_RECONCILIATION_PROJECTED_TEXT_BYTES, "text-too-large"),
    validatePath(track.filePath),
    validateTags(track.genres),
    validateTags(track.styles),
    validateTags(track.moods),
  ]);
  if (!fields.ok) return fields;

  try {
    const serialized = JSON.stringify(track);
    return typeof serialized === "string"
      ? { ok: true, bytes: utf8Bytes(serialized) }
      : failure("invalid-projection");
  } catch {
    return failure("invalid-projection");
  }
}

/** Adds measured projected bytes without overflowing the aggregate snapshot cap. */
export function accountReconciliationServerSnapshotBytes(
  currentBytes: number,
  additionalBytes: number,
): ReconciliationLimitResult {
  return accountSnapshotBytes(
    currentBytes,
    additionalBytes,
    MAX_RECONCILIATION_SERVER_SNAPSHOT_BYTES,
  );
}

/** Adds measured local bytes without overflowing the aggregate snapshot cap. */
export function accountReconciliationLocalSnapshotBytes(
  currentBytes: number,
  additionalBytes: number,
): ReconciliationLimitResult {
  return accountSnapshotBytes(
    currentBytes,
    additionalBytes,
    MAX_RECONCILIATION_LOCAL_SNAPSHOT_BYTES,
  );
}

function accountSnapshotBytes(
  currentBytes: number,
  additionalBytes: number,
  maximumBytes: number,
): ReconciliationLimitResult {
  if (
    !Number.isSafeInteger(currentBytes) ||
    currentBytes < 0 ||
    !Number.isSafeInteger(additionalBytes) ||
    additionalBytes < 0
  ) {
    return failure("invalid-projection");
  }
  if (additionalBytes > maximumBytes || currentBytes > maximumBytes - additionalBytes) {
    return failure("snapshot-too-large");
  }
  return { ok: true, bytes: currentBytes + additionalBytes };
}

/** Whether a fingerprint size is safe for the synchronous pathname MP3 writer. */
export function isSafeReconciliationMp3RatingFileSize(size: number): boolean {
  return (
    Number.isSafeInteger(size) && size >= 0 && size <= MAX_RECONCILIATION_MP3_RATING_FILE_BYTES
  );
}
