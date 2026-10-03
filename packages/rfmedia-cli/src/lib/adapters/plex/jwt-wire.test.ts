import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import {
  PLEX_JWT_ASSUMED_LIFETIME_SECONDS,
  PlexJwtWireError,
  normalizeFailure,
  readNonce,
  readTokenGrant,
} from "./jwt-wire.js";

const TOKEN_SENTINEL = "plex-jwt-sentinel-value";

describe("readTokenGrant", () => {
  it.each([["auth_token"], ["authToken"]])(
    "accepts the %s spelling of the unobserved success body (U1)",
    (field) => {
      const grant = readTokenGrant({ [field]: TOKEN_SENTINEL });

      expect(grant.token).toBe(TOKEN_SENTINEL);
    },
  );

  it("applies the assumed lifetime when no lifetime field is present (U2)", () => {
    const grant = readTokenGrant({ authToken: TOKEN_SENTINEL });

    expect(grant.lifetimeSeconds).toBe(PLEX_JWT_ASSUMED_LIFETIME_SECONDS);
    expect(grant.lifetimeAssumed).toBe(true);
  });

  it("reports observed key names without any value when no credential is present", () => {
    const body = {
      status: "ok",
      data: { user: TOKEN_SENTINEL },
      detail: "unexpected-body-text",
    };

    let failure: unknown;
    try {
      readTokenGrant(body);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(PlexJwtWireError);
    const wireError = failure as PlexJwtWireError;
    expect(wireError.code).toBe("unrecognized-token-grant");
    expect(wireError.observedKeys).toEqual(["status", "data", "data.user", "detail"]);
    expect(wireError.observedKeysTruncated).toBe(false);
    expect(wireError.message).not.toContain(TOKEN_SENTINEL);
    expect(wireError.message).not.toContain("unexpected-body-text");
    expect(inspect(wireError)).not.toContain(TOKEN_SENTINEL);
    expect(inspect(wireError)).not.toContain("unexpected-body-text");
  });
});

describe("PlexJwtWireError observedKeys bounding", () => {
  it("caps the list at twelve entries and flags truncation", () => {
    const body = Object.fromEntries(
      Array.from({ length: 15 }, (_unused, index) => [`k${String(index).padStart(2, "0")}`, index]),
    );

    const wireError = new PlexJwtWireError("unrecognized-token-grant", body);

    expect(wireError.observedKeys).toHaveLength(12);
    expect(wireError.observedKeys[0]).toBe("k00");
    expect(wireError.observedKeysTruncated).toBe(true);
  });

  it("rejects over-long, out-of-charset, and secret-shaped key names", () => {
    const body = {
      ok: 1,
      ["k".repeat(33)]: 2,
      "has space": 3,
      "has/slash": 4,
      QUFBQUFBQUFBQUFBQUFBQQ: 5,
    };

    const wireError = new PlexJwtWireError("unrecognized-token-grant", body);

    expect(wireError.observedKeys).toEqual(["ok"]);
    expect(wireError.observedKeysTruncated).toBe(true);
  });
});

describe("readNonce", () => {
  it("throws on the observed empty 200 body instead of inferring success", () => {
    expect(() => readNonce({})).toThrow(PlexJwtWireError);
  });
});

describe("normalizeFailure", () => {
  it("normalizes both observed envelopes without throwing on each other", () => {
    expect(normalizeFailure(422, { errors: [{ code: 1008, message: "…", status: 422 }] })).toEqual({
      httpStatus: 422,
      code: 1008,
    });
    expect(normalizeFailure(401, { error: "Please sign in." })).toEqual({ httpStatus: 401 });
    expect(normalizeFailure(429, { errors: "not-an-array" })).toEqual({ httpStatus: 429 });
    expect(normalizeFailure(500, undefined)).toEqual({ httpStatus: 500 });
  });
});
