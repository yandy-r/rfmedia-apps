import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadPlexAuthStoreSync, withPlexAuthStoreLock } from "./credential-store.js";
import type { PlexAuthStoreDependencies, PlexStoreMutation } from "./credential-store.js";
import type { PlexAccountProtocol, PlexNonceIssue } from "./enrollment-client.js";
import { refreshPlexCredential } from "./enrollment-refresh.js";
import type { PlexEnrollmentDependencies } from "./enrollment-support.js";
import { generatePlexClientKeyPair } from "./jwt.js";
import type { PlexClientKeyPair } from "./jwt.js";
import type { PlexTokenGrant } from "./jwt-wire.js";

const STORE_DIR_ENV = "RFMEDIA_PLEX_AUTH_DIR";
const NOW_MS = 1_800_000_000_000;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const LIFETIME_SECONDS = 6 * 24 * 60 * 60;

const ORIGIN = "http://localhost:32400";
const CLIENT_IDENTIFIER = "11111111-2222-4333-8444-555555555555";
const MACHINE_IDENTIFIER = "machine-identifier-1";
const SEEDED_CREDENTIAL = "seeded.jwt.sentinel.aaaaaaaaaa";
const REFRESHED_CREDENTIAL = "refreshed.jwt.sentinel.bbbbbbbbbb";
const PEER_CREDENTIAL = "peer.jwt.sentinel.dddddddddd";

let tempDir: string;
let originalAuthDirEnv: string | undefined;
let keyPair: PlexClientKeyPair;

interface AccountStub {
  readonly account: PlexAccountProtocol;
  nonceCalls: number;
  exchangeCalls: number;
}

function storeDeps(): PlexAuthStoreDependencies {
  return { now: () => NOW_MS };
}

async function writeMutations(mutations: readonly PlexStoreMutation[]): Promise<void> {
  await withPlexAuthStoreLock(storeDeps(), { deadlineEpochMs: NOW_MS + 5_000 }, async () => ({
    mutations,
    result: undefined,
  }));
}

/** Seeds an enrolled store whose credential expires `secondsRemaining` from now. */
async function seedStore(secondsRemaining: number): Promise<void> {
  await writeMutations([
    {
      kind: "enroll",
      clientIdentifier: CLIENT_IDENTIFIER,
      deviceName: "workstation",
      kid: keyPair.kid,
      privateKeyPkcs8Pem: keyPair.privateKeyPkcs8Pem,
    },
    {
      kind: "issue",
      credential: SEEDED_CREDENTIAL,
      issuedAtEpochSeconds: NOW_SECONDS + secondsRemaining - LIFETIME_SECONDS,
      lifetimeSeconds: LIFETIME_SECONDS,
      lifetimeAssumed: false,
    },
    { kind: "authorize-origin", origin: ORIGIN, machineIdentifier: MACHINE_IDENTIFIER },
  ]);
}

/** Account transport whose nonce carries `receivedAtEpochSeconds`. */
function createAccountStub(nonceReceivedAtEpochSeconds: number): AccountStub {
  const stub: AccountStub = {
    nonceCalls: 0,
    exchangeCalls: 0,
    account: {
      createPin: async () => {
        throw new Error("createPin belongs to login, not to refresh");
      },
      readPin: async () => {
        throw new Error("readPin belongs to login, not to refresh");
      },
      createNonce: async (): Promise<PlexNonceIssue> => {
        stub.nonceCalls += 1;
        return {
          nonce: "nonce-sentinel-cccccccccc",
          receivedAtEpochSeconds: nonceReceivedAtEpochSeconds,
        };
      },
      exchangeDeviceAssertion: async (): Promise<PlexTokenGrant> => {
        stub.exchangeCalls += 1;
        return {
          token: REFRESHED_CREDENTIAL,
          lifetimeSeconds: LIFETIME_SECONDS,
          lifetimeAssumed: false,
        };
      },
    },
  };
  return stub;
}

function dependencies(stub: AccountStub): PlexEnrollmentDependencies {
  return { account: stub.account, now: () => NOW_MS };
}

function createDeferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "plex-enrollment-refresh-"));
  originalAuthDirEnv = process.env[STORE_DIR_ENV];
  process.env[STORE_DIR_ENV] = join(tempDir, "plex-auth");
  keyPair = await generatePlexClientKeyPair();
});

afterEach(async () => {
  if (originalAuthDirEnv === undefined) delete process.env[STORE_DIR_ENV];
  else process.env[STORE_DIR_ENV] = originalAuthDirEnv;
  await rm(tempDir, { recursive: true, force: true });
});

describe("plex auth refresh", () => {
  // Mirrors jwt-provider.test.ts: both pipelines write the same
  // `lastObservedSkewSeconds`, so both must mean LOCAL minus SERVER. A server
  // instant 200 s in the past means this host runs 200 s AHEAD: +200, never -200.
  it("persists clock skew as local minus server", async () => {
    await seedStore(-90);
    const stub = createAccountStub(NOW_SECONDS - 200);

    const result = await refreshPlexCredential({ plexUrl: ORIGIN }, dependencies(stub));

    expect(result.refreshed).toBe(true);
    expect(stub.exchangeCalls).toBe(1);
    expect(loadPlexAuthStoreSync(storeDeps())?.lastObservedSkewSeconds).toBe(200);
  });

  it("stays the single-flight leader when a fresh credential leaves nothing to do", async () => {
    await seedStore(LIFETIME_SECONDS);
    const stub = createAccountStub(NOW_SECONDS);

    const result = await refreshPlexCredential({ plexUrl: ORIGIN }, dependencies(stub));

    expect(result).toMatchObject({
      refreshed: false,
      reason: "already-fresh",
      singleFlightLeader: true,
    });
    expect(stub.nonceCalls).toBe(0);
  });

  it("reports a peer adoption when the credential was rotated during the lock wait", async () => {
    await seedStore(-90);
    const stub = createAccountStub(NOW_SECONDS);
    const acquired = createDeferred();
    const release = createDeferred();

    const peer = withPlexAuthStoreLock(
      storeDeps(),
      { deadlineEpochMs: NOW_MS + 5_000 },
      async () => {
        acquired.resolve();
        await release.promise;
        return {
          mutations: [
            {
              kind: "issue" as const,
              credential: PEER_CREDENTIAL,
              issuedAtEpochSeconds: NOW_SECONDS,
              lifetimeSeconds: LIFETIME_SECONDS,
              lifetimeAssumed: false,
            },
          ],
          result: undefined,
        };
      },
    );

    await acquired.promise;
    // The pre-lock observation runs synchronously inside this call, while the
    // peer still holds the lock and the stored credential is still expired.
    const pending = refreshPlexCredential({ plexUrl: ORIGIN }, dependencies(stub));
    release.resolve();
    await peer;

    await expect(pending).resolves.toMatchObject({
      refreshed: false,
      reason: "already-fresh",
      singleFlightLeader: false,
      expiresAtEpochSeconds: NOW_SECONDS + LIFETIME_SECONDS,
    });
    expect(stub.nonceCalls).toBe(0);
  });
});
