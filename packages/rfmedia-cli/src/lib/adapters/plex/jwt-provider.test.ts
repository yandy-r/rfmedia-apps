import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MediaServerError } from "../../../types/media-server.js";
import {
  loadPlexAuthStoreSync,
  resolvePlexAuthStorePath,
  withPlexAuthStoreLock,
} from "./credential-store.js";
import type { PlexAuthStoreDependencies, PlexStoreMutation } from "./credential-store.js";
import { PlexEnrollmentClient } from "./enrollment-client.js";
import type { PlexAccountProtocol, PlexNonceIssue } from "./enrollment-client.js";
import { PlexAuthError } from "./errors.js";
import { PlexJwtTokenProvider } from "./jwt-provider.js";
import type { PlexTokenGrant } from "./jwt-wire.js";
import { generatePlexClientKeyPair } from "./jwt.js";
import type { PlexClientKeyPair } from "./jwt.js";
import {
  createPlexRotatingConnectionSettings,
  getPlexConnectionToken,
  toPlexConnectionLogContext,
} from "./types.js";
import type { PlexConnectionSettings } from "./types.js";

const NOW_MS = 1_800_000_000_000;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const LIFETIME_SECONDS = 6 * 24 * 60 * 60;
const REFRESH_MARGIN_SECONDS = 300;

const ORIGIN = "http://localhost:32400";
const CLIENT_IDENTIFIER = "11111111-2222-4333-8444-555555555555";
const MACHINE_IDENTIFIER = "machine-identifier-1";

const INITIAL_CREDENTIAL = "initial.jwt.sentinel.aaaaaaaaaa";
const REFRESHED_CREDENTIAL = "refreshed.jwt.sentinel.bbbbbbbbbb";
const PEER_CREDENTIAL = "peer.jwt.sentinel.dddddddddd";
const SECOND_CREDENTIAL = "second.jwt.sentinel.eeeeeeeeee";
const NONCE_SENTINEL = "nonce-sentinel-cccccccccc";

/** Mirrors the provider's own refusal window; both budgets are sized to it. */
const REFRESH_FAILURE_WINDOW_SECONDS = 300;

/** Mirrors the provider's per-process cap on repeated doomed refreshes. */
const MAX_FAILED_REFRESHES = 2;

const DEFAULT_GRANT: PlexTokenGrant = Object.freeze({
  token: REFRESHED_CREDENTIAL,
  lifetimeSeconds: LIFETIME_SECONDS,
  lifetimeAssumed: false,
});

let tempDir: string;
let storePath: string;
let originalAuthDirEnv: string | undefined;
let keyPair: PlexClientKeyPair;
let connection: PlexConnectionSettings;
let nowMs: number;

function storeDeps(): PlexAuthStoreDependencies {
  return { now: () => nowMs, refreshMarginSeconds: REFRESH_MARGIN_SECONDS };
}

async function writeMutations(mutations: readonly PlexStoreMutation[]): Promise<void> {
  await withPlexAuthStoreLock(storeDeps(), { deadlineEpochMs: nowMs + 5_000 }, async () => ({
    mutations,
    result: undefined,
  }));
}

/**
 * Seeds an enrolled store whose credential expires `secondsRemaining` from now.
 * A negative value seeds an already-expired credential.
 */
async function seedStore(credential: string, secondsRemaining: number): Promise<void> {
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
      credential,
      issuedAtEpochSeconds: NOW_SECONDS + secondsRemaining - LIFETIME_SECONDS,
      lifetimeSeconds: LIFETIME_SECONDS,
      lifetimeAssumed: false,
    },
    { kind: "authorize-origin", origin: ORIGIN, machineIdentifier: MACHINE_IDENTIFIER },
  ]);
}

function createProvider(account: PlexAccountProtocol): PlexJwtTokenProvider {
  return new PlexJwtTokenProvider(connection, {
    storePath,
    refreshMarginSeconds: REFRESH_MARGIN_SECONDS,
    now: () => nowMs,
    account,
  });
}

interface AccountStub {
  readonly account: PlexAccountProtocol;
  /** The signal handed to each `createNonce`, in call order. */
  readonly nonceSignals: (AbortSignal | undefined)[];
  nonceCalls: number;
  exchangeCalls: number;
}

interface AccountStubConfig {
  /** `receivedAtEpochSeconds` per `createNonce` call; the last entry repeats. */
  readonly nonceReceivedAt?: readonly number[];
  /** Grant per `exchangeDeviceAssertion` call; the last entry repeats. */
  readonly grants?: readonly PlexTokenGrant[];
  /** Thrown by `createNonce` when present, before any nonce is issued. */
  readonly nonceError?: (signal: AbortSignal | undefined) => unknown;
  /** Thrown by `exchangeDeviceAssertion` when present. */
  readonly exchangeError?: () => unknown;
}

function pick<T>(values: readonly T[] | undefined, index: number, fallback: T): T {
  if (values === undefined || values.length === 0) return fallback;
  return values[Math.min(index, values.length - 1)] ?? fallback;
}

function createAccountStub(config: AccountStubConfig = {}): AccountStub {
  const stub: AccountStub = {
    nonceSignals: [],
    nonceCalls: 0,
    exchangeCalls: 0,
    account: {
      createPin: async () => {
        throw new Error("createPin belongs to enrollment, not to the refresh provider");
      },
      readPin: async () => {
        throw new Error("readPin belongs to enrollment, not to the refresh provider");
      },
      createNonce: async (input): Promise<PlexNonceIssue> => {
        const index = stub.nonceCalls;
        stub.nonceCalls += 1;
        stub.nonceSignals.push(input.signal);
        if (config.nonceError !== undefined) throw config.nonceError(input.signal);
        return {
          nonce: `${NONCE_SENTINEL}-${index}`,
          receivedAtEpochSeconds: pick(config.nonceReceivedAt, index, NOW_SECONDS),
        };
      },
      exchangeDeviceAssertion: async (): Promise<PlexTokenGrant> => {
        const index = stub.exchangeCalls;
        stub.exchangeCalls += 1;
        if (config.exchangeError !== undefined) throw config.exchangeError();
        return pick(config.grants, index, DEFAULT_GRANT);
      },
    },
  };
  return stub;
}

async function captureRejection(pending: Promise<unknown>): Promise<MediaServerError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof MediaServerError) return error;
    throw error;
  }
  throw new Error("Expected a MediaServerError to be rejected");
}

function createDeferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  nowMs = NOW_MS;
  tempDir = await mkdtemp(join(tmpdir(), "plex-jwt-provider-"));
  originalAuthDirEnv = process.env["RFMEDIA_PLEX_AUTH_DIR"];
  process.env["RFMEDIA_PLEX_AUTH_DIR"] = join(tempDir, "plex-auth");
  storePath = resolvePlexAuthStorePath();
  keyPair = await generatePlexClientKeyPair();
  connection = createPlexRotatingConnectionSettings({
    origin: ORIGIN,
    token: INITIAL_CREDENTIAL,
    clientIdentifier: CLIENT_IDENTIFIER,
  });
});

afterEach(async () => {
  if (originalAuthDirEnv === undefined) delete process.env["RFMEDIA_PLEX_AUTH_DIR"];
  else process.env["RFMEDIA_PLEX_AUTH_DIR"] = originalAuthDirEnv;
  await rm(tempDir, { recursive: true, force: true });
});

describe("plex jwt provider refresh lifecycle", () => {
  it.each([
    { label: "a fresh credential", remaining: LIFETIME_SECONDS, kind: "fresh", exchanges: 0 },
    { label: "30 s past expiry", remaining: -30, kind: "refresh-soon", exchanges: 1 },
    { label: "90 s past expiry", remaining: -90, kind: "expired", exchanges: 1 },
  ])("resolves $label", async ({ remaining, kind, exchanges }) => {
    await seedStore(INITIAL_CREDENTIAL, remaining);
    expect(loadPlexAuthStoreSync(storeDeps())?.credentialState.kind).toBe(kind);

    const stub = createAccountStub();
    const token = await createProvider(stub.account).getToken();

    expect(stub.exchangeCalls).toBe(exchanges);
    expect(token).toBe(exchanges === 0 ? INITIAL_CREDENTIAL : REFRESHED_CREDENTIAL);
  });

  it("collapses concurrent expired reads onto exactly one refresh", async () => {
    await seedStore(INITIAL_CREDENTIAL, -90);
    const stub = createAccountStub();
    const provider = createProvider(stub.account);

    const tokens = await Promise.all([
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
    ]);

    expect(tokens).toEqual([REFRESHED_CREDENTIAL, REFRESHED_CREDENTIAL, REFRESHED_CREDENTIAL]);
    expect(stub.nonceCalls).toBe(1);
    expect(stub.exchangeCalls).toBe(1);
    expect(loadPlexAuthStoreSync(storeDeps())?.version).toBe(2);
  });

  it("adopts a peer's credential written while the lock was held, with zero network calls", async () => {
    await seedStore(INITIAL_CREDENTIAL, -90);
    const stub = createAccountStub();
    const provider = createProvider(stub.account);

    const acquired = createDeferred();
    const release = createDeferred();
    const peer = withPlexAuthStoreLock(
      storeDeps(),
      { deadlineEpochMs: nowMs + 5_000 },
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
    const pending = provider.getToken();
    await new Promise((settle) => setTimeout(settle, 80));
    release.resolve();
    await peer;

    await expect(pending).resolves.toBe(PEER_CREDENTIAL);
    expect(stub.nonceCalls).toBe(0);
    expect(stub.exchangeCalls).toBe(0);
  });

  it("persists a rate-limit window, then refuses to adopt or refresh inside it", async () => {
    await seedStore(INITIAL_CREDENTIAL, -90);
    const stub = createAccountStub({
      exchangeError: () => new PlexAuthError("PLEX_AUTH_RATE_LIMITED", { retryAfterSeconds: 287 }),
    });
    const provider = createProvider(stub.account);

    const first = await captureRejection(provider.getToken());
    expect(first.code).toBe("rate-limited");
    expect(first.retryAfterSeconds).toBe(287);
    expect(loadPlexAuthStoreSync(storeDeps())?.refreshNotBeforeEpochSeconds).toBe(
      NOW_SECONDS + 287,
    );

    // The loser's view: the peer advanced the version with a back-off mutation while
    // the credential stayed expired, so adoption must NOT fire.
    const second = await captureRejection(provider.getToken());
    expect(second.code).toBe("rate-limited");
    expect(second.retryAfterSeconds).toBe(287);
    expect(stub.nonceCalls).toBe(1);
    expect(stub.exchangeCalls).toBe(1);
  });

  it("re-fetches a nonce that arrived older than its 300 s window", async () => {
    await seedStore(INITIAL_CREDENTIAL, -90);
    const stub = createAccountStub({
      nonceReceivedAt: [NOW_SECONDS - 400, NOW_SECONDS],
    });

    await expect(createProvider(stub.account).getToken()).resolves.toBe(REFRESHED_CREDENTIAL);
    expect(stub.nonceCalls).toBe(2);
    expect(stub.exchangeCalls).toBe(1);
  });

  it("reports clock skew, never token expiry, when a fresh grant reads expired", async () => {
    await seedStore(INITIAL_CREDENTIAL, -90);
    const stub = createAccountStub({
      nonceReceivedAt: [NOW_SECONDS - 200],
      grants: [{ token: REFRESHED_CREDENTIAL, lifetimeSeconds: 100, lifetimeAssumed: false }],
    });

    const error = await captureRejection(createProvider(stub.account).getToken());

    expect(error.code).toBe("configuration");
    expect(error.message).toContain("this system's clock is wrong");
    expect(error.message).toContain("Synchronize this system's clock");
    const handle = loadPlexAuthStoreSync(storeDeps());
    expect(handle?.lastObservedSkewSeconds).toBe(200);
    expect(handle?.version).toBe(2);
  });

  it("threads cancellation to the account transport and releases the store lock", async () => {
    await seedStore(INITIAL_CREDENTIAL, -90);
    const controller = new AbortController();
    const stub = createAccountStub({
      // Mirrors the real transport: the signal that reaches plex.tv composes the
      // caller's cancellation with the refresh budget, and an abort observed
      // there surfaces as PLEX_AUTH_CANCELLED.
      nonceError: (signal) => {
        if (signal === undefined) {
          throw new Error("Expected a bounded signal to reach the account transport");
        }
        controller.abort();
        if (!signal.aborted) {
          throw new Error("Expected the caller's abort to reach the account transport");
        }
        return new PlexAuthError("PLEX_AUTH_CANCELLED");
      },
    });

    const error = await captureRejection(
      createProvider(stub.account).getToken({ signal: controller.signal }),
    );

    expect(error.message).toContain("cancelled");
    expect(stub.nonceCalls).toBe(1);
    // A locked write on a REAL clock deadline proves the lock was released in `finally`.
    await withPlexAuthStoreLock(
      { now: () => nowMs },
      { deadlineEpochMs: nowMs + 1_000 },
      async () => ({ mutations: [], result: undefined }),
    );
  });

  it("bounds the in-lock account calls even when the caller supplies no signal", async () => {
    await seedStore(INITIAL_CREDENTIAL, -90);
    const stub = createAccountStub();

    await expect(createProvider(stub.account).getToken()).resolves.toBe(REFRESHED_CREDENTIAL);

    // The refresh budget must reach the transport on its own, or the worst legal
    // account path outlives the lock-staleness threshold and a peer steals the
    // lock from this live holder.
    const [signal] = stub.nonceSignals;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });
});

describe("plex jwt provider refresh budgets", () => {
  it("persists a refusal window for a repeatable failure instead of respending nonces", async () => {
    await seedStore(INITIAL_CREDENTIAL, -90);
    const stub = createAccountStub({
      exchangeError: () => new PlexAuthError("PLEX_AUTH_INVALID_RESPONSE"),
    });
    const provider = createProvider(stub.account);

    const first = await captureRejection(provider.getToken());
    const second = await captureRejection(provider.getToken());
    const third = await captureRejection(provider.getToken());

    expect(first.code).toBe("invalid-response");
    // Sibling processes and later calls decline with ZERO network calls.
    expect([second.code, third.code]).toEqual(["rate-limited", "rate-limited"]);
    expect(stub.nonceCalls).toBe(1);
    expect(stub.exchangeCalls).toBe(1);
    expect(loadPlexAuthStoreSync(storeDeps())?.refreshNotBeforeEpochSeconds).toBe(
      NOW_SECONDS + REFRESH_FAILURE_WINDOW_SECONDS,
    );
  });

  it("caps repeated failing refreshes per process when no window is persisted", async () => {
    await seedStore(INITIAL_CREDENTIAL, -90);
    const stub = createAccountStub({
      nonceError: () => new PlexAuthError("PLEX_AUTH_UNREACHABLE"),
    });
    const provider = createProvider(stub.account);

    const codes: string[] = [];
    for (let call = 0; call < MAX_FAILED_REFRESHES + 2; call += 1) {
      codes.push((await captureRejection(provider.getToken())).code);
    }

    // The last error is replayed verbatim; only the network calls stop.
    expect(codes).toEqual(["network", "network", "network", "network"]);
    expect(stub.nonceCalls).toBe(MAX_FAILED_REFRESHES);
  });

  it("clears the failure count once a refresh produces a credential", async () => {
    await seedStore(INITIAL_CREDENTIAL, -90);
    const failing = createAccountStub({
      nonceError: () => new PlexAuthError("PLEX_AUTH_UNREACHABLE"),
    });
    // A short lifetime leaves the store refresh-soon, so the later calls refresh
    // for real without moving the clock past the failure window.
    const healthy = createAccountStub({
      grants: [{ token: REFRESHED_CREDENTIAL, lifetimeSeconds: 200, lifetimeAssumed: false }],
    });
    const provider = createProvider(failing.account);

    expect((await captureRejection(provider.getToken())).code).toBe("network");
    await expect(createProvider(healthy.account).getToken()).resolves.toBe(REFRESHED_CREDENTIAL);

    // The transient failure must not have consumed budget the later refreshes
    // depend on: both of them still reach the network.
    expect((await captureRejection(provider.getToken())).code).toBe("network");
    expect((await captureRejection(provider.getToken())).code).toBe("network");
    expect(failing.nonceCalls).toBe(MAX_FAILED_REFRESHES + 1);
  });
});

describe("plex jwt provider reactive retry", () => {
  it("never hands a joiner back the credential the server just rejected", async () => {
    await seedStore(INITIAL_CREDENTIAL, -90);

    const leaderStub = createAccountStub();
    const leader = createProvider(leaderStub.account);

    // The joiner's connection still holds the credential its request was refused
    // with — which is exactly what the in-flight refresh is about to install.
    const rejectedConnection = createPlexRotatingConnectionSettings({
      origin: ORIGIN,
      token: REFRESHED_CREDENTIAL,
      clientIdentifier: CLIENT_IDENTIFIER,
    });
    const joinerStub = createAccountStub({
      grants: [
        { token: SECOND_CREDENTIAL, lifetimeSeconds: LIFETIME_SECONDS, lifetimeAssumed: false },
      ],
    });
    const joiner = new PlexJwtTokenProvider(rejectedConnection, {
      storePath,
      refreshMarginSeconds: REFRESH_MARGIN_SECONDS,
      now: () => nowMs,
      account: joinerStub.account,
    });

    // Same synchronous turn: the joiner joins the leader's in-flight refresh.
    const leaderPending = leader.getToken();
    const joinerPending = joiner.handleAuthFailure(401);

    await expect(leaderPending).resolves.toBe(REFRESHED_CREDENTIAL);
    await expect(joinerPending).resolves.toBe("retry");
    expect(joinerStub.exchangeCalls).toBe(1);
    expect(getPlexConnectionToken(rejectedConnection, ORIGIN)).toBe(SECOND_CREDENTIAL);
  });
});

describe("plex jwt provider secret custody", () => {
  it("keeps every credential sentinel out of urls, errors, and diagnostics", async () => {
    const pemBody = keyPair.privateKeyPkcs8Pem.replace(/-----[^-]*-----/g, "").replace(/\s+/gu, "");
    const privateKeySentinel = pemBody.slice(0, 40);
    await seedStore(INITIAL_CREDENTIAL, -90);

    const requestUrls: string[] = [];
    let capturedAssertion = "";
    let nonceStatus = 200;

    const provider = new PlexJwtTokenProvider(connection, {
      storePath,
      refreshMarginSeconds: REFRESH_MARGIN_SECONDS,
      now: () => nowMs,
      account: new PlexEnrollmentClient({
        now: () => nowMs,
        fetch: async (input, init) => {
          const url = String(input);
          requestUrls.push(url);
          const headers = { date: new Date(nowMs).toUTCString() };
          if (url.includes("/auth/nonce")) {
            return nonceStatus === 200
              ? new Response(JSON.stringify({ nonce: NONCE_SENTINEL }), { status: 200, headers })
              : new Response(JSON.stringify({ error: "Please sign in." }), { status: 401 });
          }
          const body = JSON.parse(String(init?.body)) as { deviceJWT: string };
          capturedAssertion = body.deviceJWT;
          return new Response(
            JSON.stringify({ authToken: REFRESHED_CREDENTIAL, expires_in: LIFETIME_SECONDS }),
            { status: 200, headers },
          );
        },
      }),
    });

    await expect(provider.getToken()).resolves.toBe(REFRESHED_CREDENTIAL);
    expect(capturedAssertion.length).toBeGreaterThan(0);

    // Expire the ROTATED credential, then fail the next refresh to obtain an error sink.
    nowMs += (LIFETIME_SECONDS + 120) * 1000;
    nonceStatus = 401;
    const error = await captureRejection(provider.getToken());
    expect(error.code).toBe("authentication");

    const handle = loadPlexAuthStoreSync(storeDeps());
    const sinks = [
      ...requestUrls,
      inspect(error),
      JSON.stringify(provider),
      JSON.stringify(toPlexConnectionLogContext(connection)),
      inspect(connection),
      JSON.stringify(handle),
      inspect(handle),
    ];
    const sentinels = [
      privateKeySentinel,
      INITIAL_CREDENTIAL,
      REFRESHED_CREDENTIAL,
      NONCE_SENTINEL,
      capturedAssertion,
    ];

    for (const sink of sinks) {
      for (const sentinel of sentinels) {
        expect(sink).not.toContain(sentinel);
      }
    }
  });
});
