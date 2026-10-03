import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  BackupArtifactOutcome,
  BackupError,
  BackupFailedArtifactOutcome,
  BackupFailedDryRunResult,
  BackupFailedResult,
  BackupManifest,
  BackupMissingArtifact,
  BackupPublishedResult,
  BackupRecoveryFailure,
  BackupRestoreHint,
  BackupResult,
  BackupVerifyResult,
} from "../types/backup.js";
import {
  BackupSchemaError,
  MAX_BACKUP_MANIFEST_BYTES,
  MAX_BACKUP_MANIFEST_ENTRIES,
  MAX_BACKUP_MANIFEST_WARNINGS,
  parseBackupManifestJson,
  validateBackupManifest,
  type BackupSchemaErrorCode,
} from "./backup-schema.js";

const SHA256 = "a".repeat(64);

function validManifest(): Record<string, unknown> {
  return {
    schemaVersion: "rfapps-backup.v1",
    backupId: "backup-2026-07-29",
    createdAt: "2026-07-29T10:00:00.000Z",
    completedAt: "2026-07-29T10:02:00.000Z",
    consistency: "detected-compose-writers-stopped",
    project: {
      name: "media",
      resolvedConfigSha256: SHA256,
      dockerAuthorityFingerprint: "b".repeat(64),
    },
    scope: {
      requestedServices: ["plex"],
      resolvedServices: ["plex", "database"],
      quiescedServices: ["database"],
      previouslyRunningServices: ["database"],
    },
    helperImage: {
      reference:
        "docker.io/library/alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1",
      resolvedImageId: "sha256:" + "c".repeat(64),
    },
    skipped: [
      {
        id: "mount-skip-0001",
        mountType: "tmpfs",
        reasonCode: "NON_PERSISTENT_TMPFS",
        consumers: [{ service: "plex", target: "/transcode", readOnly: false }],
      },
    ],
    mounts: [
      {
        id: "mount-0001",
        artifactPath: "artifacts/mount-0001.tar.gz",
        source: { kind: "bind", path: "/srv/media" },
        consumers: [{ service: "plex", target: "/data", readOnly: false }],
        archiveStartedAt: "2026-07-29T10:00:30.000Z",
        archiveCompletedAt: "2026-07-29T10:01:00.000Z",
        compressedBytes: 42,
        sha256: SHA256,
        restore: {
          kind: "bind-tar",
          destinationPath: "/srv/media",
          precondition: "writers-stopped",
        },
      },
      {
        id: "mount-0002",
        artifactPath: "artifacts/mount-0002.tar.gz",
        source: {
          kind: "volume",
          name: "media_database",
          driver: "local",
          external: false,
        },
        consumers: [{ service: "database", target: "/var/lib/data", readOnly: false }],
        archiveStartedAt: "2026-07-29T10:01:00.000Z",
        archiveCompletedAt: "2026-07-29T10:01:30.000Z",
        compressedBytes: 84,
        sha256: "d".repeat(64),
        restore: {
          kind: "volume-tar",
          volumeName: "media_database",
          driver: "local",
          external: false,
          precondition: "writers-stopped",
        },
      },
    ],
    warnings: [
      {
        code: "FILESYSTEM_LEVEL_ONLY",
        message: "Archives do not provide application-native database consistency.",
      },
    ],
  };
}

function expectSchemaError(input: unknown, code: BackupSchemaErrorCode): void {
  try {
    validateBackupManifest(input);
    throw new Error("Expected backup schema validation to fail");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(BackupSchemaError);
    if (error instanceof BackupSchemaError) {
      expect(error.code).toBe(code);
      expect(Buffer.byteLength(error.message, "utf8")).toBeLessThanOrEqual(4096);
    }
  }
}

describe("backup manifest schema", () => {
  it("validates the complete bind and volume contract and returns a fresh value", () => {
    const input = validManifest();
    const manifest = validateBackupManifest(input);

    expect(manifest).toEqual(input);
    expect(manifest).not.toBe(input);
    expect(manifest.mounts).not.toBe(input["mounts"]);
    expect(manifest.mounts[0]?.consumers).not.toBe(
      (input["mounts"] as Record<string, unknown>[])[0]?.["consumers"],
    );
  });

  it("parses bounded JSON into the validated manifest contract", () => {
    const manifest = parseBackupManifestJson(JSON.stringify(validManifest()));

    expectTypeOf(manifest).toEqualTypeOf<BackupManifest>();
    expect(manifest.schemaVersion).toBe("rfapps-backup.v1");
  });

  it("rejects malformed and oversized encoded JSON before schema traversal", () => {
    expect(() => parseBackupManifestJson("{")).toThrowError(
      expect.objectContaining({ code: "BACKUP_SCHEMA_INVALID_JSON" }),
    );
    expect(() =>
      parseBackupManifestJson(Buffer.alloc(MAX_BACKUP_MANIFEST_BYTES + 1, 0x20)),
    ).toThrowError(expect.objectContaining({ code: "BACKUP_SCHEMA_TOO_LARGE" }));
  });

  it("rejects unsupported versions without reflecting the supplied value", () => {
    const input = validManifest();
    const secretVersion = "rfapps-backup.secret-token";
    input["schemaVersion"] = secretVersion;

    try {
      validateBackupManifest(input);
      throw new Error("Expected version validation to fail");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(BackupSchemaError);
      if (error instanceof BackupSchemaError) {
        expect(error.code).toBe("BACKUP_SCHEMA_UNSUPPORTED_VERSION");
        expect(error.message).not.toContain(secretVersion);
      }
    }
  });

  it.each([
    {
      name: "an unknown top-level key",
      mutate: (manifest: Record<string, unknown>) => {
        manifest["secret"] = "do-not-reflect";
      },
    },
    {
      name: "a missing required top-level key",
      mutate: (manifest: Record<string, unknown>) => {
        delete manifest["scope"];
      },
    },
    {
      name: "an unknown nested key",
      mutate: (manifest: Record<string, unknown>) => {
        const project = manifest["project"] as Record<string, unknown>;
        project["endpoint"] = "ssh://secret@example.test";
      },
    },
  ])("rejects $name with exact-key validation", ({ mutate }) => {
    const manifest = validManifest();
    mutate(manifest);
    expectSchemaError(manifest, "BACKUP_SCHEMA_INVALID");
  });

  it.each([
    {
      name: "scope",
      select: (manifest: Record<string, unknown>) => manifest["scope"] as Record<string, unknown>,
    },
    {
      name: "helper image",
      select: (manifest: Record<string, unknown>) =>
        manifest["helperImage"] as Record<string, unknown>,
    },
    {
      name: "mount",
      select: (manifest: Record<string, unknown>) =>
        (manifest["mounts"] as Record<string, unknown>[])[0]!,
    },
    {
      name: "bind source",
      select: (manifest: Record<string, unknown>) =>
        (manifest["mounts"] as Record<string, unknown>[])[0]?.["source"] as Record<string, unknown>,
    },
    {
      name: "volume source",
      select: (manifest: Record<string, unknown>) =>
        (manifest["mounts"] as Record<string, unknown>[])[1]?.["source"] as Record<string, unknown>,
    },
    {
      name: "bind restore hint",
      select: (manifest: Record<string, unknown>) =>
        (manifest["mounts"] as Record<string, unknown>[])[0]?.["restore"] as Record<
          string,
          unknown
        >,
    },
    {
      name: "volume restore hint",
      select: (manifest: Record<string, unknown>) =>
        (manifest["mounts"] as Record<string, unknown>[])[1]?.["restore"] as Record<
          string,
          unknown
        >,
    },
    {
      name: "consumer",
      select: (manifest: Record<string, unknown>) =>
        (
          (manifest["mounts"] as Record<string, unknown>[])[0]?.["consumers"] as Record<
            string,
            unknown
          >[]
        )[0]!,
    },
    {
      name: "skipped entry",
      select: (manifest: Record<string, unknown>) =>
        (manifest["skipped"] as Record<string, unknown>[])[0]!,
    },
    {
      name: "warning",
      select: (manifest: Record<string, unknown>) =>
        (manifest["warnings"] as Record<string, unknown>[])[0]!,
    },
  ])("rejects an unknown key in nested $name evidence", ({ select }) => {
    const manifest = validManifest();
    select(manifest)["unknown"] = "must-not-survive";
    expectSchemaError(manifest, "BACKUP_SCHEMA_INVALID");
  });

  it("enforces byte-based string, warning, and entry limits", () => {
    const longString = validManifest();
    const project = longString["project"] as Record<string, unknown>;
    project["name"] = "é".repeat(2049);
    expectSchemaError(longString, "BACKUP_SCHEMA_LIMIT_EXCEEDED");

    const warnings = validManifest();
    warnings["warnings"] = Array.from({ length: MAX_BACKUP_MANIFEST_WARNINGS + 1 }, () => ({
      code: "FILESYSTEM_LEVEL_ONLY",
      message: "bounded",
    }));
    expectSchemaError(warnings, "BACKUP_SCHEMA_LIMIT_EXCEEDED");

    const entries = validManifest();
    const template = (entries["mounts"] as Record<string, unknown>[])[0];
    entries["mounts"] = Array.from({ length: MAX_BACKUP_MANIFEST_ENTRIES + 1 }, (_, index) => ({
      ...template,
      id: `mount-${index}`,
      artifactPath: `artifacts/mount-${index}.tar.gz`,
    }));
    expectSchemaError(entries, "BACKUP_SCHEMA_LIMIT_EXCEEDED");
  });

  it("requires IDs and artifact paths to be unique", () => {
    const duplicateId = validManifest();
    const mounts = duplicateId["mounts"] as Record<string, unknown>[];
    const skipped = duplicateId["skipped"] as Record<string, unknown>[];
    skipped[0] = { ...skipped[0], id: mounts[0]?.["id"] };
    expectSchemaError(duplicateId, "BACKUP_SCHEMA_DUPLICATE_ID");

    const duplicatePath = validManifest();
    const duplicateMounts = duplicatePath["mounts"] as Record<string, unknown>[];
    duplicateMounts[1] = {
      ...duplicateMounts[1],
      artifactPath: duplicateMounts[0]?.["artifactPath"],
    };
    expectSchemaError(duplicatePath, "BACKUP_SCHEMA_DUPLICATE_ARTIFACT_PATH");
  });

  it.each([
    "/absolute.tar.gz",
    "../escape.tar.gz",
    "artifacts/../escape.tar.gz",
    "artifacts/./archive.tar.gz",
    "artifacts//archive.tar.gz",
    "artifacts\\archive.tar.gz",
    "artifacts/archive\0.tar.gz",
    "other/archive.tar.gz",
    "artifacts/",
  ])("rejects unsafe or non-canonical artifact path %s", (artifactPath) => {
    const manifest = validManifest();
    const mounts = manifest["mounts"] as Record<string, unknown>[];
    mounts[0] = { ...mounts[0], artifactPath };

    expectSchemaError(manifest, "BACKUP_SCHEMA_UNSAFE_PATH");
  });

  it("rejects noncanonical bind paths, invalid timestamps, and empty provenance", () => {
    const noncanonical = validManifest();
    const noncanonicalMounts = noncanonical["mounts"] as Record<string, unknown>[];
    const source = noncanonicalMounts[0]?.["source"] as Record<string, unknown>;
    const restore = noncanonicalMounts[0]?.["restore"] as Record<string, unknown>;
    source["path"] = "/srv/../media";
    restore["destinationPath"] = "/srv/../media";
    expectSchemaError(noncanonical, "BACKUP_SCHEMA_INVALID");

    const invalidTimestamp = validManifest();
    invalidTimestamp["createdAt"] = "yesterday";
    expectSchemaError(invalidTimestamp, "BACKUP_SCHEMA_INVALID");

    const emptyConsumers = validManifest();
    const emptyMounts = emptyConsumers["mounts"] as Record<string, unknown>[];
    emptyMounts[0] = { ...emptyMounts[0], consumers: [] };
    expectSchemaError(emptyConsumers, "BACKUP_SCHEMA_INVALID");
  });

  it("rejects mismatched source and restore discriminants", () => {
    const manifest = validManifest();
    const mounts = manifest["mounts"] as Record<string, unknown>[];
    mounts[0] = {
      ...mounts[0],
      restore: {
        kind: "volume-tar",
        volumeName: "wrong",
        driver: "local",
        external: false,
        precondition: "writers-stopped",
      },
    };

    expectSchemaError(manifest, "BACKUP_SCHEMA_INVALID");
  });

  it("exposes an exhaustive restore-hint union", () => {
    const summarize = (hint: BackupRestoreHint): string => {
      switch (hint.kind) {
        case "bind-tar":
          return hint.destinationPath;
        case "volume-tar":
          return hint.volumeName;
      }
    };

    expect(summarize(validateBackupManifest(validManifest()).mounts[0]!.restore)).toBe(
      "/srv/media",
    );
  });

  it("makes contradictory result and artifact states unrepresentable", () => {
    expectTypeOf<{
      id: string;
      artifactPath: string;
      status: "archived";
    }>().not.toMatchTypeOf<BackupArtifactOutcome>();
    type ContradictoryPublished = Omit<BackupPublishedResult, "success"> & {
      success: false;
    };
    type PublishedWithFailure = Omit<BackupPublishedResult, "artifacts"> & {
      artifacts: BackupFailedArtifactOutcome[];
    };
    type PublishedWithErrors = Omit<BackupPublishedResult, "errors"> & {
      errors: [BackupError];
    };
    type SuccessfulVerify = Extract<BackupVerifyResult, { status: "succeeded" }>;
    type ContradictoryVerify = Omit<SuccessfulVerify, "success"> & {
      success: false;
    };
    type VerifiedWithErrors = Omit<SuccessfulVerify, "errors"> & {
      errors: [BackupError];
    };
    type VerifiedWithFailure = Omit<SuccessfulVerify, "artifacts"> & {
      artifacts: BackupMissingArtifact[];
    };
    type RemovedFailure = Extract<BackupFailedResult, { stagingDisposition: "none" | "removed" }>;
    type RemovedWithRecovery = Omit<RemovedFailure, "recoveryFailures"> & {
      recoveryFailures: [BackupRecoveryFailure];
    };
    type RetainedFailure = Extract<
      BackupFailedResult,
      { stagingDisposition: "retained-incomplete" }
    >;
    type RetainedWithoutRecovery = Omit<RetainedFailure, "recoveryFailures"> & {
      recoveryFailures: [];
    };
    type FailedDryRunExitOne = Omit<BackupFailedDryRunResult, "exitCode"> & {
      exitCode: 1;
    };
    type FailedDryRunExitTwo = Omit<BackupFailedDryRunResult, "exitCode"> & {
      exitCode: 2;
    };

    expectTypeOf<ContradictoryPublished>().not.toMatchTypeOf<BackupResult>();
    expectTypeOf<PublishedWithFailure>().not.toMatchTypeOf<BackupResult>();
    expectTypeOf<PublishedWithErrors>().not.toMatchTypeOf<BackupResult>();
    expectTypeOf<ContradictoryVerify>().not.toMatchTypeOf<BackupVerifyResult>();
    expectTypeOf<VerifiedWithErrors>().not.toMatchTypeOf<BackupVerifyResult>();
    expectTypeOf<VerifiedWithFailure>().not.toMatchTypeOf<BackupVerifyResult>();
    expectTypeOf<FailedDryRunExitOne>().toMatchTypeOf<BackupResult>();
    expectTypeOf<FailedDryRunExitTwo>().toMatchTypeOf<BackupResult>();
    expectTypeOf<RemovedWithRecovery>().not.toMatchTypeOf<BackupResult>();
    expectTypeOf<RetainedWithoutRecovery>().toMatchTypeOf<BackupResult>();
  });
});
