import { posix } from "node:path";

import {
  BACKUP_HELPER_IMAGE_REFERENCE,
  BACKUP_MANIFEST_SCHEMA_VERSION,
  type BackupBindRestoreHint,
  type BackupConsumer,
  type BackupManifest,
  type BackupManifestMount,
  type BackupRestoreHint,
  type BackupSkippedSource,
  type BackupSource,
  type BackupVolumeRestoreHint,
  type BackupWarning,
} from "../types/backup.js";

export const MAX_BACKUP_MANIFEST_BYTES = 4 * 1024 * 1024;
export const MAX_BACKUP_MANIFEST_ENTRIES = 10_000;
export const MAX_BACKUP_MANIFEST_WARNINGS = 1_000;
export const MAX_BACKUP_STRING_BYTES = 4_096;

export type BackupSchemaErrorCode =
  | "BACKUP_SCHEMA_INVALID_JSON"
  | "BACKUP_SCHEMA_TOO_LARGE"
  | "BACKUP_SCHEMA_UNSUPPORTED_VERSION"
  | "BACKUP_SCHEMA_INVALID"
  | "BACKUP_SCHEMA_LIMIT_EXCEEDED"
  | "BACKUP_SCHEMA_DUPLICATE_ID"
  | "BACKUP_SCHEMA_DUPLICATE_ARTIFACT_PATH"
  | "BACKUP_SCHEMA_UNSAFE_PATH";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const ARTIFACT_PATH_PATTERN = /^artifacts\/[^/]+\.tar\.gz$/u;

export class BackupSchemaError extends Error {
  override readonly name = "BackupSchemaError";

  constructor(
    readonly code: BackupSchemaErrorCode,
    message: string,
  ) {
    super(message.slice(0, MAX_BACKUP_STRING_BYTES));
  }
}

function fail(code: BackupSchemaErrorCode, message: string): never {
  throw new BackupSchemaError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) {
    fail("BACKUP_SCHEMA_INVALID", `${context} must be an object`);
  }
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  context: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    fail("BACKUP_SCHEMA_INVALID", `${context} has invalid keys`);
  }
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail("BACKUP_SCHEMA_INVALID", `${context} must be a non-empty string`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_BACKUP_STRING_BYTES) {
    fail("BACKUP_SCHEMA_LIMIT_EXCEEDED", `${context} exceeds the string limit`);
  }
  return value;
}

function requireTimestamp(value: unknown, context: string): string {
  const timestamp = requireString(value, context);
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    fail("BACKUP_SCHEMA_INVALID", `${context} must be a canonical UTC timestamp`);
  }
  return timestamp;
}

function requireCanonicalBindPath(value: unknown, context: string): string {
  const sourcePath = requireString(value, context);
  if (
    !posix.isAbsolute(sourcePath) ||
    posix.normalize(sourcePath) !== sourcePath ||
    sourcePath.includes("//")
  ) {
    fail("BACKUP_SCHEMA_INVALID", `${context} must be a canonical absolute path`);
  }
  return sourcePath;
}

function requireStringLiteral<const T extends string>(
  value: unknown,
  expected: T,
  context: string,
): T {
  const actual = requireString(value, context);
  if (actual !== expected) {
    fail("BACKUP_SCHEMA_INVALID", `${context} has an invalid value`);
  }
  return expected;
}

function requireBoolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") {
    fail("BACKUP_SCHEMA_INVALID", `${context} must be a boolean`);
  }
  return value;
}

function requireCount(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) {
    fail("BACKUP_SCHEMA_INVALID", `${context} must be a non-negative safe integer`);
  }
  return value;
}

function requireSha256(value: unknown, context: string): string {
  const digest = requireString(value, context);
  if (!SHA256_PATTERN.test(digest)) {
    fail("BACKUP_SCHEMA_INVALID", `${context} must be a lowercase SHA-256 digest`);
  }
  return digest;
}

function requireStringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_BACKUP_MANIFEST_ENTRIES) {
    fail(
      Array.isArray(value) ? "BACKUP_SCHEMA_LIMIT_EXCEEDED" : "BACKUP_SCHEMA_INVALID",
      `${context} must be a bounded array`,
    );
  }
  return value.map((entry, index) => requireString(entry, `${context}[${index}]`));
}

function validateConsumer(value: unknown, context: string): BackupConsumer {
  const consumer = requireRecord(value, context);
  requireExactKeys(consumer, ["service", "target", "readOnly"], [], context);
  return {
    service: requireString(consumer["service"], `${context}.service`),
    target: requireString(consumer["target"], `${context}.target`),
    readOnly: requireBoolean(consumer["readOnly"], `${context}.readOnly`),
  };
}

function validateConsumers(
  value: unknown,
  context: string,
  requireAtLeastOne = false,
): BackupConsumer[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_BACKUP_MANIFEST_ENTRIES ||
    (requireAtLeastOne && value.length === 0)
  ) {
    fail(
      Array.isArray(value) && value.length > MAX_BACKUP_MANIFEST_ENTRIES
        ? "BACKUP_SCHEMA_LIMIT_EXCEEDED"
        : "BACKUP_SCHEMA_INVALID",
      `${context} must be a bounded array`,
    );
  }
  return value.map((entry, index) => validateConsumer(entry, `${context}[${index}]`));
}

function validateSource(value: unknown, context: string): BackupSource {
  const source = requireRecord(value, context);
  const kind = requireString(source["kind"], `${context}.kind`);
  if (kind === "bind") {
    requireExactKeys(source, ["kind", "path"], [], context);
    return {
      kind: "bind",
      path: requireCanonicalBindPath(source["path"], `${context}.path`),
    };
  }
  if (kind === "volume") {
    requireExactKeys(source, ["kind", "name", "driver", "external"], [], context);
    return {
      kind: "volume",
      name: requireString(source["name"], `${context}.name`),
      driver: requireString(source["driver"], `${context}.driver`),
      external: requireBoolean(source["external"], `${context}.external`),
    };
  }
  fail("BACKUP_SCHEMA_INVALID", `${context}.kind is unsupported`);
}

function validateRestoreHint(value: unknown, context: string): BackupRestoreHint {
  const restore = requireRecord(value, context);
  const kind = requireString(restore["kind"], `${context}.kind`);
  if (kind === "bind-tar") {
    requireExactKeys(restore, ["kind", "destinationPath", "precondition"], [], context);
    const result: BackupBindRestoreHint = {
      kind: "bind-tar",
      destinationPath: requireCanonicalBindPath(
        restore["destinationPath"],
        `${context}.destinationPath`,
      ),
      precondition: requireStringLiteral(
        restore["precondition"],
        "writers-stopped",
        `${context}.precondition`,
      ),
    };
    return result;
  }
  if (kind === "volume-tar") {
    requireExactKeys(
      restore,
      ["kind", "volumeName", "driver", "external", "precondition"],
      [],
      context,
    );
    const result: BackupVolumeRestoreHint = {
      kind: "volume-tar",
      volumeName: requireString(restore["volumeName"], `${context}.volumeName`),
      driver: requireString(restore["driver"], `${context}.driver`),
      external: requireBoolean(restore["external"], `${context}.external`),
      precondition: requireStringLiteral(
        restore["precondition"],
        "writers-stopped",
        `${context}.precondition`,
      ),
    };
    return result;
  }
  fail("BACKUP_SCHEMA_INVALID", `${context}.kind is unsupported`);
}

function validateArtifactPath(value: unknown, context: string): string {
  if (typeof value === "string" && value.includes("\0")) {
    fail("BACKUP_SCHEMA_UNSAFE_PATH", `${context} is not a safe artifact path`);
  }
  const artifactPath = requireString(value, context);
  if (
    !ARTIFACT_PATH_PATTERN.test(artifactPath) ||
    artifactPath.startsWith("/") ||
    artifactPath.includes("\\") ||
    artifactPath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    fail("BACKUP_SCHEMA_UNSAFE_PATH", `${context} is not a safe artifact path`);
  }
  return artifactPath;
}

function validateMount(value: unknown, index: number): BackupManifestMount {
  const context = `mounts[${index}]`;
  const mount = requireRecord(value, context);
  requireExactKeys(
    mount,
    [
      "id",
      "artifactPath",
      "source",
      "consumers",
      "archiveStartedAt",
      "archiveCompletedAt",
      "compressedBytes",
      "sha256",
      "restore",
    ],
    [],
    context,
  );
  const source = validateSource(mount["source"], `${context}.source`);
  const restore = validateRestoreHint(mount["restore"], `${context}.restore`);
  if (
    (source.kind === "bind" &&
      (restore.kind !== "bind-tar" || restore.destinationPath !== source.path)) ||
    (source.kind === "volume" &&
      (restore.kind !== "volume-tar" ||
        restore.volumeName !== source.name ||
        restore.driver !== source.driver ||
        restore.external !== source.external))
  ) {
    fail("BACKUP_SCHEMA_INVALID", `${context} restore hint does not match its source`);
  }
  return {
    id: requireString(mount["id"], `${context}.id`),
    artifactPath: validateArtifactPath(mount["artifactPath"], `${context}.artifactPath`),
    source,
    consumers: validateConsumers(mount["consumers"], `${context}.consumers`, true),
    archiveStartedAt: requireTimestamp(mount["archiveStartedAt"], `${context}.archiveStartedAt`),
    archiveCompletedAt: requireTimestamp(
      mount["archiveCompletedAt"],
      `${context}.archiveCompletedAt`,
    ),
    compressedBytes: requireCount(mount["compressedBytes"], `${context}.compressedBytes`),
    sha256: requireSha256(mount["sha256"], `${context}.sha256`),
    restore,
  };
}

const SKIP_REASON_CODES = new Set([
  "NON_PERSISTENT_TMPFS",
  "HOST_SYSTEM_PATH",
  "SOCKET_SOURCE",
  "DEVICE_SOURCE",
  "READ_ONLY_SYSTEM_FILE",
]);

function validateSkipped(value: unknown, index: number): BackupSkippedSource {
  const context = `skipped[${index}]`;
  const skipped = requireRecord(value, context);
  requireExactKeys(skipped, ["id", "mountType", "reasonCode", "consumers"], ["source"], context);
  const reasonCode = requireString(skipped["reasonCode"], `${context}.reasonCode`);
  if (!SKIP_REASON_CODES.has(reasonCode)) {
    fail("BACKUP_SCHEMA_INVALID", `${context}.reasonCode is unsupported`);
  }
  const source = Object.hasOwn(skipped, "source")
    ? requireString(skipped["source"], `${context}.source`)
    : undefined;
  return {
    id: requireString(skipped["id"], `${context}.id`),
    mountType: requireString(skipped["mountType"], `${context}.mountType`),
    reasonCode: reasonCode as BackupSkippedSource["reasonCode"],
    ...(source === undefined ? {} : { source }),
    consumers: validateConsumers(skipped["consumers"], `${context}.consumers`),
  };
}

function validateWarning(value: unknown, index: number): BackupWarning {
  const context = `warnings[${index}]`;
  const warning = requireRecord(value, context);
  requireExactKeys(warning, ["code", "message"], [], context);
  return {
    code: requireString(warning["code"], `${context}.code`),
    message: requireString(warning["message"], `${context}.message`),
  };
}

export function validateBackupManifest(value: unknown): BackupManifest {
  const manifest = requireRecord(value, "manifest");
  requireExactKeys(
    manifest,
    [
      "schemaVersion",
      "backupId",
      "createdAt",
      "completedAt",
      "consistency",
      "project",
      "scope",
      "helperImage",
      "skipped",
      "mounts",
      "warnings",
    ],
    [],
    "manifest",
  );

  if (manifest["schemaVersion"] !== BACKUP_MANIFEST_SCHEMA_VERSION) {
    fail("BACKUP_SCHEMA_UNSUPPORTED_VERSION", "Unsupported backup manifest version");
  }

  const project = requireRecord(manifest["project"], "project");
  requireExactKeys(
    project,
    ["name", "resolvedConfigSha256", "dockerAuthorityFingerprint"],
    [],
    "project",
  );
  const scope = requireRecord(manifest["scope"], "scope");
  requireExactKeys(
    scope,
    ["requestedServices", "resolvedServices", "quiescedServices", "previouslyRunningServices"],
    [],
    "scope",
  );
  const helperImage = requireRecord(manifest["helperImage"], "helperImage");
  requireExactKeys(helperImage, ["reference", "resolvedImageId"], [], "helperImage");

  if (!Array.isArray(manifest["mounts"]) || !Array.isArray(manifest["skipped"])) {
    fail("BACKUP_SCHEMA_INVALID", "mounts and skipped must be arrays");
  }
  if (manifest["mounts"].length + manifest["skipped"].length > MAX_BACKUP_MANIFEST_ENTRIES) {
    fail("BACKUP_SCHEMA_LIMIT_EXCEEDED", "manifest entry count exceeds the limit");
  }
  if (
    !Array.isArray(manifest["warnings"]) ||
    manifest["warnings"].length > MAX_BACKUP_MANIFEST_WARNINGS
  ) {
    fail(
      Array.isArray(manifest["warnings"])
        ? "BACKUP_SCHEMA_LIMIT_EXCEEDED"
        : "BACKUP_SCHEMA_INVALID",
      "warnings must be a bounded array",
    );
  }

  const mounts = manifest["mounts"].map((entry, index) => validateMount(entry, index));
  const skipped = manifest["skipped"].map((entry, index) => validateSkipped(entry, index));
  const ids = new Set<string>();
  for (const entry of [...mounts, ...skipped]) {
    if (ids.has(entry.id)) {
      fail("BACKUP_SCHEMA_DUPLICATE_ID", "Backup entry IDs must be unique");
    }
    ids.add(entry.id);
  }
  const artifactPaths = new Set<string>();
  for (const mount of mounts) {
    if (artifactPaths.has(mount.artifactPath)) {
      fail("BACKUP_SCHEMA_DUPLICATE_ARTIFACT_PATH", "Backup artifact paths must be unique");
    }
    artifactPaths.add(mount.artifactPath);
  }

  const resolvedImageId = requireString(
    helperImage["resolvedImageId"],
    "helperImage.resolvedImageId",
  );
  if (!IMAGE_ID_PATTERN.test(resolvedImageId)) {
    fail("BACKUP_SCHEMA_INVALID", "helperImage.resolvedImageId must be immutable");
  }

  return {
    schemaVersion: BACKUP_MANIFEST_SCHEMA_VERSION,
    backupId: requireString(manifest["backupId"], "backupId"),
    createdAt: requireTimestamp(manifest["createdAt"], "createdAt"),
    completedAt: requireTimestamp(manifest["completedAt"], "completedAt"),
    consistency: requireStringLiteral(
      manifest["consistency"],
      "detected-compose-writers-stopped",
      "consistency",
    ),
    project: {
      name: requireString(project["name"], "project.name"),
      resolvedConfigSha256: requireSha256(
        project["resolvedConfigSha256"],
        "project.resolvedConfigSha256",
      ),
      dockerAuthorityFingerprint: requireSha256(
        project["dockerAuthorityFingerprint"],
        "project.dockerAuthorityFingerprint",
      ),
    },
    scope: {
      requestedServices: requireStringArray(scope["requestedServices"], "scope.requestedServices"),
      resolvedServices: requireStringArray(scope["resolvedServices"], "scope.resolvedServices"),
      quiescedServices: requireStringArray(scope["quiescedServices"], "scope.quiescedServices"),
      previouslyRunningServices: requireStringArray(
        scope["previouslyRunningServices"],
        "scope.previouslyRunningServices",
      ),
    },
    helperImage: {
      reference: requireStringLiteral(
        helperImage["reference"],
        BACKUP_HELPER_IMAGE_REFERENCE,
        "helperImage.reference",
      ),
      resolvedImageId,
    },
    skipped,
    mounts,
    warnings: manifest["warnings"].map((entry, index) => validateWarning(entry, index)),
  };
}

export function parseBackupManifestJson(input: string | Uint8Array): BackupManifest {
  const inputBytes =
    typeof input === "string" ? Buffer.byteLength(input, "utf8") : input.byteLength;
  if (inputBytes > MAX_BACKUP_MANIFEST_BYTES) {
    fail("BACKUP_SCHEMA_TOO_LARGE", "Backup manifest exceeds the size limit");
  }
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("BACKUP_SCHEMA_INVALID_JSON", "Backup manifest is not valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail("BACKUP_SCHEMA_INVALID_JSON", "Backup manifest is not valid JSON");
  }
  return validateBackupManifest(parsed);
}
