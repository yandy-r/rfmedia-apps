import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BackupManifest } from "../types/backup.js";
import { MAX_BACKUP_MANIFEST_ENTRIES } from "./backup-schema.js";
import {
  BackupStorageError,
  createBackupArtifact,
  discardBackupArtifact,
  finalizeBackupArtifact,
  listBackupRegularArtifacts,
  publishBackupManifest,
  removeIncompleteBackupBundle,
  reserveBackupBundle,
  retainIncompleteBackupBundle,
  validateBackupDestination,
} from "./backup-storage.js";

const SHA256 = "a".repeat(64);

function manifest(): BackupManifest {
  return {
    schemaVersion: "rfapps-backup.v1",
    backupId: "backup-test",
    createdAt: "2026-07-29T10:00:00.000Z",
    completedAt: "2026-07-29T10:01:00.000Z",
    consistency: "detected-compose-writers-stopped",
    project: {
      name: "test",
      resolvedConfigSha256: SHA256,
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
    mounts: [
      {
        id: "mount-0001",
        artifactPath: "artifacts/mount-0001.tar.gz",
        source: { kind: "bind", path: "/srv/app" },
        consumers: [{ service: "app", target: "/data", readOnly: false }],
        archiveStartedAt: "2026-07-29T10:00:10.000Z",
        archiveCompletedAt: "2026-07-29T10:00:20.000Z",
        compressedBytes: 7,
        sha256: SHA256,
        restore: {
          kind: "bind-tar",
          destinationPath: "/srv/app",
          precondition: "writers-stopped",
        },
      },
    ],
    warnings: [],
  };
}

describe("backup storage", () => {
  let root: string;
  let destination: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rfapps-backup-storage-"));
    destination = join(root, "destination");
    await mkdir(destination, { mode: 0o700 });
  });

  afterEach(async () => {
    await chmod(destination, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  it("returns a canonical owned writable real destination", async () => {
    const validated = await validateBackupDestination(join(destination, "."));

    expect(validated.path).toBe(destination);
    expect(validated.device).toBeTypeOf("number");
    expect(validated.inode).toBeTypeOf("number");
  });

  it("rejects non-directories, symlink components, and non-writable destinations", async () => {
    const filePath = join(root, "file");
    await writeFile(filePath, "not a directory", "utf8");
    await expect(validateBackupDestination(filePath)).rejects.toMatchObject({
      code: "BACKUP_DESTINATION_UNSAFE",
    });

    const aliasPath = join(root, "alias");
    await symlink(destination, aliasPath);
    await expect(validateBackupDestination(aliasPath)).rejects.toMatchObject({
      code: "BACKUP_PATH_UNSAFE",
    });

    await chmod(destination, 0o500);
    await expect(validateBackupDestination(destination)).rejects.toMatchObject({
      code: "BACKUP_DESTINATION_NOT_WRITABLE",
    });
  });

  it("reserves a private no-clobber bundle and artifacts directory", async () => {
    const validated = await validateBackupDestination(destination);
    const bundle = await reserveBackupBundle(validated, "rfapps-backup-test");

    expect((await stat(bundle.bundlePath)).mode & 0o777).toBe(0o700);
    expect((await stat(bundle.artifactsPath)).mode & 0o777).toBe(0o700);
    await expect(reserveBackupBundle(validated, "rfapps-backup-test")).rejects.toMatchObject({
      code: "BACKUP_BUNDLE_EXISTS",
    });
  });

  it("reports a retained reservation when failure follows bundle-directory creation", async () => {
    const validated = await validateBackupDestination(destination);
    const bundlePath = join(destination, "rfapps-backup-retained-reservation");
    const artifactsPath = join(bundlePath, "artifacts");
    const secret = "storage-provider-secret";
    const mkdirReservation = vi.fn(
      async (path: string, options: { readonly mode: number }): Promise<void> => {
        if (path === artifactsPath) throw new Error(secret);
        await mkdir(path, options);
      },
    );

    let reservationError: unknown;
    try {
      await reserveBackupBundle(validated, "rfapps-backup-retained-reservation", {
        mkdir: mkdirReservation,
      });
    } catch (error) {
      reservationError = error;
    }

    expect(reservationError).toBeInstanceOf(BackupStorageError);
    expect(reservationError).toMatchObject({
      code: "BACKUP_STORAGE_IO",
      retainedReservation: {
        bundlePath,
        stagingDisposition: "retained-incomplete",
      },
    });
    expect((await stat(bundlePath)).isDirectory()).toBe(true);
    await expect(lstat(artifactsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates, syncs, and discards exclusive private artifact files", async () => {
    const bundle = await reserveBackupBundle(
      await validateBackupDestination(destination),
      "rfapps-backup-test",
    );
    const artifact = await createBackupArtifact(bundle, "artifacts/mount-0001.tar.gz");
    await artifact.handle.writeFile(Buffer.from([0x00, 0xff, 0x42]));
    await finalizeBackupArtifact(artifact);

    expect((await stat(artifact.path)).mode & 0o777).toBe(0o600);
    expect(await readFile(artifact.path)).toEqual(Buffer.from([0x00, 0xff, 0x42]));
    await expect(createBackupArtifact(bundle, "artifacts/mount-0001.tar.gz")).rejects.toMatchObject(
      { code: "BACKUP_FILE_EXISTS" },
    );

    const discarded = await createBackupArtifact(bundle, "artifacts/mount-0002.tar.gz");
    await discardBackupArtifact(discarded);
    await expect(lstat(discarded.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects replacement of the reserved artifacts directory", async () => {
    const bundle = await reserveBackupBundle(
      await validateBackupDestination(destination),
      "rfapps-backup-test",
    );
    const replacement = join(root, "replacement");
    await mkdir(replacement);
    await rm(bundle.artifactsPath, { recursive: true });
    await symlink(replacement, bundle.artifactsPath);

    await expect(createBackupArtifact(bundle, "artifacts/mount-0001.tar.gz")).rejects.toMatchObject(
      { code: "BACKUP_PATH_UNSAFE" },
    );
  });

  it("does not discard a replacement for the reserved artifact handle", async () => {
    const bundle = await reserveBackupBundle(
      await validateBackupDestination(destination),
      "rfapps-backup-test",
    );
    const artifact = await createBackupArtifact(bundle, "artifacts/mount-0001.tar.gz");
    const movedPath = join(bundle.artifactsPath, "moved.tar.gz");
    await rename(artifact.path, movedPath);
    await writeFile(artifact.path, "replacement", { mode: 0o600 });

    await expect(discardBackupArtifact(artifact)).rejects.toMatchObject({
      code: "BACKUP_PATH_UNSAFE",
    });
    expect(await readFile(artifact.path, "utf8")).toBe("replacement");
  });

  it("rejects a substituted artifact parent even when the file inode still matches", async () => {
    const bundle = await reserveBackupBundle(
      await validateBackupDestination(destination),
      "rfapps-backup-test",
    );
    const artifact = await createBackupArtifact(bundle, "artifacts/mount-0001.tar.gz");
    await artifact.handle.writeFile("archive");
    const originalArtifacts = join(bundle.bundlePath, "original-artifacts");
    await rename(bundle.artifactsPath, originalArtifacts);
    await mkdir(bundle.artifactsPath, { mode: 0o700 });
    await link(join(originalArtifacts, "mount-0001.tar.gz"), artifact.path);

    await expect(finalizeBackupArtifact(artifact)).rejects.toMatchObject({
      code: "BACKUP_PATH_UNSAFE",
    });
  });

  it("bounds artifact discovery before materializing more than 10,000 entries", async () => {
    const bundle = await reserveBackupBundle(
      await validateBackupDestination(destination),
      "rfapps-backup-test",
    );
    const source = join(bundle.artifactsPath, "source");
    await writeFile(source, "");
    for (let start = 0; start <= MAX_BACKUP_MANIFEST_ENTRIES; start += 250) {
      const batchSize = Math.min(250, MAX_BACKUP_MANIFEST_ENTRIES + 1 - start);
      await Promise.all(
        Array.from({ length: batchSize }, (_, offset) =>
          link(source, join(bundle.artifactsPath, `entry-${start + offset}.tar.gz`)),
        ),
      );
    }

    await expect(listBackupRegularArtifacts(bundle.bundlePath)).rejects.toMatchObject({
      code: "BACKUP_DIRECTORY_LIMIT_EXCEEDED",
    });
  });

  it("publishes a private manifest last without replacing an existing manifest", async () => {
    const bundle = await reserveBackupBundle(
      await validateBackupDestination(destination),
      "rfapps-backup-test",
    );

    expect(await readdir(bundle.bundlePath)).toEqual(["artifacts"]);
    const manifestPath = await publishBackupManifest(bundle, manifest());

    expect(manifestPath).toBe(bundle.manifestPath);
    expect((await stat(manifestPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual(manifest());
    expect((await readdir(bundle.bundlePath)).sort()).toEqual(["artifacts", "manifest.json"]);
    await expect(publishBackupManifest(bundle, manifest())).rejects.toMatchObject({
      code: "BACKUP_MANIFEST_EXISTS",
    });
  });

  it("retains incomplete bundles when safe automatic removal is unavailable", async () => {
    const validated = await validateBackupDestination(destination);
    const retained = await reserveBackupBundle(validated, "rfapps-backup-retain");
    await expect(removeIncompleteBackupBundle(retained)).rejects.toMatchObject({
      code: "BACKUP_STORAGE_IO",
      path: retained.bundlePath,
    });
    expect(await retainIncompleteBackupBundle(retained)).toBe(retained.bundlePath);
    expect((await stat(retained.bundlePath)).isDirectory()).toBe(true);

    await publishBackupManifest(retained, manifest());
    await expect(removeIncompleteBackupBundle(retained)).rejects.toBeInstanceOf(BackupStorageError);
    await expect(retainIncompleteBackupBundle(retained)).rejects.toMatchObject({
      code: "BACKUP_BUNDLE_COMPLETE",
    });
  });

  it("does not delete a substituted path during incomplete-bundle cleanup", async () => {
    const bundle = await reserveBackupBundle(
      await validateBackupDestination(destination),
      "rfapps-backup-substitution",
    );
    const originalBundlePath = join(destination, "original-bundle");
    await rename(bundle.bundlePath, originalBundlePath);
    await mkdir(bundle.bundlePath, { mode: 0o700 });
    await mkdir(join(bundle.bundlePath, "artifacts"), { mode: 0o700 });
    const canaryPath = join(bundle.bundlePath, "do-not-delete");
    await writeFile(canaryPath, "replacement", { mode: 0o600 });

    await expect(removeIncompleteBackupBundle(bundle)).rejects.toMatchObject({
      code: "BACKUP_PATH_UNSAFE",
      path: bundle.bundlePath,
    });
    expect(await readFile(canaryPath, "utf8")).toBe("replacement");
    expect((await stat(originalBundlePath)).isDirectory()).toBe(true);
  });
});
