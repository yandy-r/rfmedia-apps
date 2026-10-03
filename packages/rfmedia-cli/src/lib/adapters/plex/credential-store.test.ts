import { chmodSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PlexAuthError } from "./errors.js";
import {
  loadPlexAuthStoreSync,
  plexAuthStoreExistsSync,
  readStoredCredential,
  readStoredSigningKey,
  resolvePlexAuthStorePath,
  withPlexAuthStoreLock,
} from "./credential-store.js";
import type { PlexAuthStoreDependencies, PlexStoreMutation } from "./credential-store.js";

const NOW_MS = 1_800_000_000_000;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const LIFETIME_SECONDS = 6 * 24 * 60 * 60;

const ORIGIN = "http://localhost:32400";
const OTHER_ORIGIN = "http://192.168.1.50:32400";
const MACHINE_IDENTIFIER = "machine-identifier-1";
const CREDENTIAL = "plex.credential.sentinel";
const PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nprivate.key.sentinel\n-----END PRIVATE KEY-----";

let tempDir: string;
let authDir: string;
let storePath: string;
let originalAuthDirEnv: string | undefined;

const deps: PlexAuthStoreDependencies = { now: () => NOW_MS };

function budget(): { readonly deadlineEpochMs: number } {
  return { deadlineEpochMs: NOW_MS + 5_000 };
}

const ENROLLMENT_MUTATIONS: readonly PlexStoreMutation[] = [
  {
    kind: "enroll",
    clientIdentifier: "11111111-2222-4333-8444-555555555555",
    deviceName: "workstation",
    kid: "kid-thumbprint",
    privateKeyPkcs8Pem: PRIVATE_KEY,
  },
  {
    kind: "issue",
    credential: CREDENTIAL,
    issuedAtEpochSeconds: NOW_SECONDS,
    lifetimeSeconds: LIFETIME_SECONDS,
    lifetimeAssumed: true,
  },
  { kind: "authorize-origin", origin: ORIGIN, machineIdentifier: MACHINE_IDENTIFIER },
];

async function writeMutations(
  mutations: readonly PlexStoreMutation[],
  overrides?: PlexAuthStoreDependencies,
): Promise<void> {
  await withPlexAuthStoreLock(overrides ?? deps, budget(), async () => ({
    mutations,
    result: undefined,
  }));
}

async function enroll(): Promise<void> {
  await writeMutations(ENROLLMENT_MUTATIONS);
}

function captureSync(run: () => unknown): PlexAuthError {
  try {
    run();
  } catch (error) {
    if (error instanceof PlexAuthError) return error;
    throw error;
  }
  throw new Error("Expected a PlexAuthError to be thrown");
}

async function captureAsync(run: () => Promise<unknown>): Promise<PlexAuthError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof PlexAuthError) return error;
    throw error;
  }
  throw new Error("Expected a PlexAuthError to be rejected");
}

function onDiskVersion(): number {
  const document = JSON.parse(readFileSync(storePath, "utf8")) as { version: number };
  return document.version;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "plex-auth-store-"));
  authDir = join(tempDir, "plex-auth");
  originalAuthDirEnv = process.env["RFMEDIA_PLEX_AUTH_DIR"];
  process.env["RFMEDIA_PLEX_AUTH_DIR"] = authDir;
  storePath = resolvePlexAuthStorePath();
});

afterEach(async () => {
  if (originalAuthDirEnv === undefined) delete process.env["RFMEDIA_PLEX_AUTH_DIR"];
  else process.env["RFMEDIA_PLEX_AUTH_DIR"] = originalAuthDirEnv;
  await rm(tempDir, { recursive: true, force: true });
});

describe("plex credential store custody", () => {
  it("creates an owner-only store in an owner-only directory", async () => {
    expect(plexAuthStoreExistsSync()).toBe(false);

    await enroll();

    expect(plexAuthStoreExistsSync()).toBe(true);
    expect(lstatSync(authDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(storePath).mode & 0o777).toBe(0o600);

    const handle = loadPlexAuthStoreSync(deps);
    expect(handle?.version).toBe(1);
    expect(handle?.fileMode).toBe(0o600);
    expect(handle?.lockPath).toBe(`${storePath}.lock`);
    expect(handle?.credentialState).toEqual({
      kind: "fresh",
      expiresAtEpochSeconds: NOW_SECONDS + LIFETIME_SECONDS,
      secondsRemaining: LIFETIME_SECONDS,
    });
    expect(handle?.lifetimeAssumed).toBe(true);
    expect(handle?.refreshNotBeforeEpochSeconds).toBe(0);
    expect(handle?.lastObservedSkewSeconds).toBeNull();
    expect(handle?.authorizedOrigins).toEqual([
      {
        origin: ORIGIN,
        machineIdentifier: MACHINE_IDENTIFIER,
        authorizedAtEpochSeconds: NOW_SECONDS,
        lastVerifiedAtEpochSeconds: NOW_SECONDS,
      },
    ]);
  });

  it("refuses a symlinked store path", async () => {
    await enroll();
    const linkPath = join(authDir, "store-link.json");
    symlinkSync(storePath, linkPath);

    delete process.env["RFMEDIA_PLEX_AUTH_DIR"];
    const error = captureSync(() => loadPlexAuthStoreSync({ ...deps, storePath: linkPath }));

    expect(error.code).toBe("PLEX_AUTH_STORE_UNSAFE_PATH");
  });

  it("refuses a group/world-writable parent directory", async () => {
    await enroll();
    chmodSync(authDir, 0o777);

    const error = captureSync(() => loadPlexAuthStoreSync(deps));

    expect(error.code).toBe("PLEX_AUTH_STORE_UNSAFE_PATH");
    // No silent repair: the directory is exactly as the operator left it.
    expect(lstatSync(authDir).mode & 0o777).toBe(0o777);
  });

  it("refuses a group-readable store at load and never repairs it", async () => {
    await enroll();
    chmodSync(storePath, 0o640);

    const error = captureSync(() => loadPlexAuthStoreSync(deps));

    expect(error.code).toBe("PLEX_AUTH_STORE_PERMISSIONS");
    expect(error.remediation).toBe(`Run: chmod 600 ${storePath}`);
    expect(lstatSync(storePath).mode & 0o777).toBe(0o640);
  });

  it("replaces the store atomically on a new owner-only inode", async () => {
    await enroll();
    const before = lstatSync(storePath);

    await writeMutations([{ kind: "back-off", notBeforeEpochSeconds: NOW_SECONDS + 287 }]);

    const after = lstatSync(storePath);
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o600);
    const handle = loadPlexAuthStoreSync(deps);
    expect(handle?.version).toBe(2);
    expect(handle?.refreshNotBeforeEpochSeconds).toBe(NOW_SECONDS + 287);
  });

  it("keeps the signing key and credential off the handle", async () => {
    await enroll();
    const handle = loadPlexAuthStoreSync(deps);
    if (handle === undefined) throw new Error("Expected an enrolled store");

    expect(Reflect.ownKeys(handle)).not.toContain("credential");
    expect(Reflect.ownKeys(handle)).not.toContain("privateKeyPkcs8Pem");
    for (const rendered of [JSON.stringify(handle), inspect(handle)]) {
      expect(rendered).not.toContain(CREDENTIAL);
      expect(rendered).not.toContain("private.key.sentinel");
    }

    expect(readStoredCredential(handle, ORIGIN)).toBe(CREDENTIAL);
    expect(readStoredSigningKey(handle)).toBe(PRIVATE_KEY);

    const error = captureSync(() => readStoredCredential(handle, OTHER_ORIGIN));
    expect(error.code).toBe("PLEX_AUTH_ORIGIN_NOT_AUTHORIZED");
  });

  it("rejects a write whose version was advanced by a writer that bypassed the lock", async () => {
    await enroll();
    for (let step = 0; step < 6; step += 1) {
      await writeMutations([{ kind: "back-off", notBeforeEpochSeconds: NOW_SECONDS + step }]);
    }
    expect(onDiskVersion()).toBe(7);

    const error = await captureAsync(async () =>
      withPlexAuthStoreLock(deps, budget(), async (current) => {
        expect(current?.version).toBe(7);
        // A non-conforming writer rewrites the document IN PLACE, so the inode is
        // unchanged and only the content-axis version check can catch it.
        const document = JSON.parse(readFileSync(storePath, "utf8")) as Record<string, unknown>;
        writeFileSync(storePath, JSON.stringify({ ...document, version: 8 }), { mode: 0o600 });
        return {
          mutations: [{ kind: "back-off", notBeforeEpochSeconds: NOW_SECONDS + 99 }],
          result: undefined,
        };
      }),
    );

    expect(error.code).toBe("PLEX_AUTH_STORE_VERSION_CONFLICT");
    expect(onDiskVersion()).toBe(8);
    expect(loadPlexAuthStoreSync(deps)?.version).toBe(8);
  });
});
