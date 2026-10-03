import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BackupManifest } from "../types/backup.js";
import { MAX_BACKUP_MANIFEST_BYTES, BackupSchemaError } from "./backup-schema.js";
import { BackupStorageError } from "./backup-storage.js";
import { verifyBackup } from "./backup-verify.js";

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function manifestFor(
  artifacts: readonly { id: string; path: string; bytes: Buffer }[],
): BackupManifest {
  return {
    schemaVersion: "rfapps-backup.v1",
    backupId: "backup-test",
    createdAt: "2026-07-29T10:00:00.000Z",
    completedAt: "2026-07-29T10:01:00.000Z",
    consistency: "detected-compose-writers-stopped",
    project: {
      name: "test",
      resolvedConfigSha256: "a".repeat(64),
      dockerAuthorityFingerprint: "b".repeat(64),
    },
    scope: {
      requestedServices: ["app"],
      resolvedServices: ["app"],
      quiescedServices: ["app"],
      previouslyRunningServices: ["app"],
    },
    helperImage: {
      reference:
        "docker.io/library/alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1",
      resolvedImageId: `sha256:${"c".repeat(64)}`,
    },
    skipped: [],
    mounts: artifacts.map((artifact) => ({
      id: artifact.id,
      artifactPath: artifact.path,
      source: { kind: "bind" as const, path: `/srv/${artifact.id}` },
      consumers: [{ service: "app", target: "/data", readOnly: false }],
      archiveStartedAt: "2026-07-29T10:00:10.000Z",
      archiveCompletedAt: "2026-07-29T10:00:20.000Z",
      compressedBytes: artifact.bytes.byteLength,
      sha256: digest(artifact.bytes),
      restore: {
        kind: "bind-tar" as const,
        destinationPath: `/srv/${artifact.id}`,
        precondition: "writers-stopped" as const,
      },
    })),
    warnings: [{ code: "FILESYSTEM_LEVEL_ONLY", message: "Filesystem-level backup." }],
  };
}

describe("offline backup verification", () => {
  let root: string;
  let bundle: string;
  let artifacts: string;
  let manifestPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rfapps-backup-verify-"));
    bundle = join(root, "bundle");
    artifacts = join(bundle, "artifacts");
    manifestPath = join(bundle, "manifest.json");
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeManifest(manifest: BackupManifest): Promise<void> {
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  }

  it("streams declared binary artifacts and returns a successful v1 result", async () => {
    const bytes = Buffer.from([0x00, 0xff, 0x42, 0x10]);
    const manifest = manifestFor([
      { id: "mount-0001", path: "artifacts/mount-0001.tar.gz", bytes },
    ]);
    await writeFile(join(artifacts, "mount-0001.tar.gz"), bytes, { mode: 0o600 });
    await writeManifest(manifest);

    const result = await verifyBackup(manifestPath);

    expect(result).toMatchObject({
      schemaVersion: "rfapps-backup-verify-result.v1",
      operation: "backup-verify",
      status: "succeeded",
      success: true,
      exitCode: 0,
      dryRun: false,
      manifestPath,
      bundlePath: bundle,
      summary: {
        declaredArtifacts: 1,
        verifiedArtifacts: 1,
        unexpectedArtifacts: 0,
        missingArtifacts: 0,
        unsafeArtifacts: 0,
        sizeMismatches: 0,
        checksumMismatches: 0,
      },
    });
    expect(result.artifacts).toEqual([
      {
        id: "mount-0001",
        artifactPath: "artifacts/mount-0001.tar.gz",
        status: "verified",
        expectedBytes: bytes.byteLength,
        actualBytes: bytes.byteLength,
        expectedSha256: digest(bytes),
        actualSha256: digest(bytes),
      },
    ]);
    expect(result.warnings).toEqual(manifest.warnings);
  });

  it("reports missing, size, checksum, and unexpected regular files in deterministic order", async () => {
    const expected = Buffer.from("expected");
    const manifest = manifestFor([
      { id: "mount-b", path: "artifacts/mount-b.tar.gz", bytes: expected },
      { id: "mount-a", path: "artifacts/mount-a.tar.gz", bytes: expected },
      { id: "mount-c", path: "artifacts/mount-c.tar.gz", bytes: expected },
    ]);
    await writeFile(join(artifacts, "mount-a.tar.gz"), Buffer.from("mutation"), { mode: 0o600 });
    await writeFile(join(artifacts, "mount-b.tar.gz"), Buffer.from("x"), { mode: 0o600 });
    await writeFile(join(artifacts, "unexpected.tar.gz"), Buffer.from("extra"), { mode: 0o600 });
    await writeManifest(manifest);

    const result = await verifyBackup(manifestPath);

    expect(result.exitCode).toBe(1);
    expect(result.artifacts.map(({ artifactPath, status }) => [artifactPath, status])).toEqual([
      ["artifacts/mount-a.tar.gz", "checksum-mismatch"],
      ["artifacts/mount-b.tar.gz", "size-mismatch"],
      ["artifacts/mount-c.tar.gz", "missing"],
      ["artifacts/unexpected.tar.gz", "unexpected"],
    ]);
    expect(result.artifacts[1]).not.toHaveProperty("actualSha256");
    expect(result.summary).toMatchObject({
      unexpectedArtifacts: 1,
      missingArtifacts: 1,
      sizeMismatches: 1,
      checksumMismatches: 1,
    });
    expect(
      result.errors.every(({ kind, stage }) => kind === "operational" && stage === "verify"),
    ).toBe(true);
  });

  it("rejects symlink substitution without reading its target", async () => {
    const bytes = Buffer.from("secret target");
    const manifest = manifestFor([
      { id: "mount-0001", path: "artifacts/mount-0001.tar.gz", bytes },
    ]);
    const outside = join(root, "outside.tar.gz");
    await writeFile(outside, bytes);
    await symlink(outside, join(artifacts, "mount-0001.tar.gz"));
    await writeManifest(manifest);

    const result = await verifyBackup(manifestPath);

    expect(result.exitCode).toBe(2);
    expect(result.artifacts[0]).toMatchObject({
      id: "mount-0001",
      status: "unsafe",
    });
    expect(result.summary.unsafeArtifacts).toBe(1);
  });

  it("does not follow an undeclared regular-file candidate replaced by a symlink", async () => {
    const bytes = Buffer.from("declared");
    await writeFile(join(artifacts, "mount-0001.tar.gz"), bytes, { mode: 0o600 });
    const candidate = join(artifacts, "unexpected.tar.gz");
    const outside = join(root, "outside.tar.gz");
    await writeFile(candidate, "original");
    await writeFile(outside, "outside");
    await rm(candidate);
    await symlink(outside, candidate);
    await writeManifest(
      manifestFor([{ id: "mount-0001", path: "artifacts/mount-0001.tar.gz", bytes }]),
    );

    const result = await verifyBackup(manifestPath);

    expect(result.exitCode).toBe(0);
    expect(result.artifacts).toHaveLength(1);
  });

  it("rejects symlinked and oversized manifests before parsing", async () => {
    const realManifest = join(root, "real-manifest.json");
    await writeFile(realManifest, "{}");
    await symlink(realManifest, manifestPath);
    await expect(verifyBackup(manifestPath)).rejects.toBeInstanceOf(BackupStorageError);

    await rm(manifestPath);
    await writeFile(manifestPath, Buffer.alloc(MAX_BACKUP_MANIFEST_BYTES + 1, 0x20));
    await expect(verifyBackup(manifestPath)).rejects.toBeInstanceOf(BackupSchemaError);
  });

  it("reports a declared non-regular artifact and ignores undeclared directories", async () => {
    const bytes = Buffer.from("directory");
    const manifest = manifestFor([
      { id: "mount-0001", path: "artifacts/mount-0001.tar.gz", bytes },
    ]);
    await mkdir(join(artifacts, "mount-0001.tar.gz"));
    await mkdir(join(artifacts, "ignored-directory"));
    await writeManifest(manifest);

    const result = await verifyBackup(manifestPath);

    expect(result.exitCode).toBe(1);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({
      id: "mount-0001",
      status: "not-regular",
    });
  });
});
