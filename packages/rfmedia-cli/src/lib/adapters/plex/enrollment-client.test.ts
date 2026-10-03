import { describe, expect, it } from "vitest";

import { PlexEnrollmentClient } from "./enrollment-client.js";
import { PLEX_TOKEN_PATH } from "./jwt-wire.js";

const CLIENT_IDENTIFIER = "rfmedia-test-client";
const DEVICE_JWT = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl";

/** Records the requested URL and answers every request with one fixed status. */
function stubStatus(status: number, requested: string[]): PlexEnrollmentClient {
  return new PlexEnrollmentClient({
    fetch: (input: string | URL | Request) => {
      requested.push(input instanceof Request ? input.url : String(input));
      return Promise.resolve(new Response("{}", { status }));
    },
  });
}

describe("PlexEnrollmentClient 404 classification", () => {
  it("reports a 404 on the unverified token path as an unrecognized response", async () => {
    const requested: string[] = [];
    const client = stubStatus(404, requested);

    await expect(
      client.exchangeDeviceAssertion({
        deviceJwt: DEVICE_JWT,
        clientIdentifier: CLIENT_IDENTIFIER,
      }),
    ).rejects.toMatchObject({ name: "PlexAuthError", code: "PLEX_AUTH_INVALID_RESPONSE" });

    // A re-enrollment prompt here would mint a new device on every refresh.
    expect(requested[0]).toContain(PLEX_TOKEN_PATH);
  });

  it("still reports a 404 on the verified pin path as an expired enrollment", async () => {
    const requested: string[] = [];
    const client = stubStatus(404, requested);

    await expect(
      client.readPin({
        pinId: 1,
        deviceJwt: DEVICE_JWT,
        clientIdentifier: CLIENT_IDENTIFIER,
      }),
    ).rejects.toMatchObject({ name: "PlexAuthError", code: "PLEX_AUTH_ENROLLMENT_EXPIRED" });
  });
});
