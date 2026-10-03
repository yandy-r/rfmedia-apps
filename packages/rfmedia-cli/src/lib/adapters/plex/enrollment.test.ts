import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MediaServerError } from "../../../types/media-server.js";
import type { PlexTransport } from "./client.js";
import {
  enrollPlexClient,
  forgetPlexEnrollment,
  PLEX_AUTHORIZED_DEVICES_URL,
} from "./enrollment.js";
import type { PlexEnrollmentDependencies } from "./enrollment.js";
import type { PlexAccountProtocol } from "./enrollment-client.js";
import { PlexAuthError } from "./errors.js";
import { PLEX_JWT_ASSUMED_LIFETIME_SECONDS } from "./jwt-wire.js";

const STORE_DIR_ENV = "RFMEDIA_PLEX_AUTH_DIR";
const ORIGIN = "http://localhost:32400";
const CLIENT_IDENTIFIER = "11111111-1111-1111-1111-111111111111";
const ISSUED_CREDENTIAL = "issued-account-jwt";
const MACHINE_IDENTIFIER = "abc123machine";
const FIXED_NOW_MS = 1_700_000_000_000;

/** Fake plex.tv account transport; every enrollment call resolves immediately. */
function createFakeAccount(): PlexAccountProtocol {
  return {
    createPin: async () => ({ pinId: 42, code: "ABCD1234", expiresInSeconds: 1800 }),
    readPin: async () => ({ kind: "claimed" as const, token: ISSUED_CREDENTIAL }),
    createNonce: async () => ({ nonce: "nonce-value", receivedAtEpochSeconds: 0 }),
    exchangeDeviceAssertion: async () => ({
      token: "refreshed",
      lifetimeSeconds: 60,
      lifetimeAssumed: false,
    }),
  };
}

/** Injected PMS transport standing in for the verify-before-persist probe. */
function createProbeTransport(respond: () => Promise<unknown>): PlexTransport {
  return {
    async request<T>(): Promise<T> {
      return (await respond()) as T;
    },
  };
}

describe("plex enrollment use-cases", () => {
  let storeDir: string;
  let storePath: string;
  let previousStoreDir: string | undefined;
  let probeCalls: number;

  beforeEach(async () => {
    storeDir = await mkdtemp(join(tmpdir(), "plex-enrollment-"));
    storePath = join(storeDir, "store.json");
    previousStoreDir = process.env[STORE_DIR_ENV];
    process.env[STORE_DIR_ENV] = storeDir;
    probeCalls = 0;
  });

  afterEach(async () => {
    if (previousStoreDir === undefined) {
      delete process.env[STORE_DIR_ENV];
    } else {
      process.env[STORE_DIR_ENV] = previousStoreDir;
    }
    await rm(storeDir, { recursive: true, force: true });
  });

  function buildDependencies(respond: () => Promise<unknown>): PlexEnrollmentDependencies {
    let uuidCount = 0;
    return {
      account: createFakeAccount(),
      createProbeTransport: () =>
        createProbeTransport(async () => {
          probeCalls += 1;
          return respond();
        }),
      now: () => FIXED_NOW_MS,
      delay: async () => undefined,
      notify: () => undefined,
      hostname: () => "test-host",
      randomUUID: () => {
        uuidCount += 1;
        return uuidCount === 1 ? CLIENT_IDENTIFIER : `jti-${String(uuidCount)}`;
      },
    };
  }

  const acceptingProbe = async (): Promise<unknown> => ({
    MediaContainer: { machineIdentifier: MACHINE_IDENTIFIER, friendlyName: "Test Server" },
  });

  it("persists exactly one enroll/issue/authorize-origin write after the probe accepts", async () => {
    const result = await enrollPlexClient(
      { plexUrl: ORIGIN, timeoutSeconds: 60 },
      buildDependencies(acceptingProbe),
    );

    expect(probeCalls).toBe(1);
    expect(result).toMatchObject({
      origin: ORIGIN,
      clientIdentifier: CLIENT_IDENTIFIER,
      deviceName: "test-host",
      machineIdentifier: MACHINE_IDENTIFIER,
      lifetimeAssumed: true,
      replacedExistingEnrollment: false,
    });

    const document = JSON.parse(await readFile(storePath, "utf8")) as Record<string, unknown>;

    // `version === 1` is the proof that exactly one store write happened.
    expect(document["version"]).toBe(1);
    expect(document["schema"]).toBe(1);

    // enroll
    expect(document["clientIdentifier"]).toBe(CLIENT_IDENTIFIER);
    expect(document["deviceName"]).toBe("test-host");
    expect(document["kid"]).toBe(result.kid);
    expect(String(document["privateKeyPkcs8Pem"])).toContain("BEGIN PRIVATE KEY");

    // issue
    expect(document["credential"]).toBe(ISSUED_CREDENTIAL);
    expect(document["issuedAtEpochSeconds"]).toBe(Math.floor(FIXED_NOW_MS / 1000));
    expect(document["lifetimeSeconds"]).toBe(PLEX_JWT_ASSUMED_LIFETIME_SECONDS);
    expect(document["lifetimeAssumed"]).toBe(true);

    // authorize-origin
    expect(document["authorizedOrigins"]).toEqual([
      {
        origin: ORIGIN,
        machineIdentifier: MACHINE_IDENTIFIER,
        authorizedAtEpochSeconds: Math.floor(FIXED_NOW_MS / 1000),
        lastVerifiedAtEpochSeconds: Math.floor(FIXED_NOW_MS / 1000),
      },
    ]);
  });

  it("discards the credential and writes nothing when the server rejects the probe", async () => {
    const rejectingProbe = async (): Promise<unknown> => {
      throw new MediaServerError("Authentication failed (HTTP 401)", {
        code: "authentication",
        serverType: "plex",
        operation: "verify Plex enrollment",
        statusCode: 401,
        retryable: false,
      });
    };

    const failure = enrollPlexClient(
      { plexUrl: ORIGIN, timeoutSeconds: 60 },
      buildDependencies(rejectingProbe),
    );
    await expect(failure).rejects.toBeInstanceOf(PlexAuthError);
    await expect(failure).rejects.toMatchObject({ code: "PLEX_AUTH_PMS_REJECTED" });

    await expect(access(storePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("destroys the store on logout and reports revocation as manual", async () => {
    const dependencies = buildDependencies(acceptingProbe);
    await enrollPlexClient({ plexUrl: ORIGIN, timeoutSeconds: 60 }, dependencies);
    await expect(access(storePath)).resolves.toBeUndefined();

    const result = await forgetPlexEnrollment({}, dependencies);

    expect(result).toEqual({
      removedOrigins: [ORIGIN],
      keyDestroyed: true,
      serverSideRevocation: "manual",
      authorizedDevicesUrl: PLEX_AUTHORIZED_DEVICES_URL,
      deviceName: "test-host",
    });
    expect(PLEX_AUTHORIZED_DEVICES_URL).toBe("https://app.plex.tv/desktop/#!/settings/devices");
    await expect(access(storePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
