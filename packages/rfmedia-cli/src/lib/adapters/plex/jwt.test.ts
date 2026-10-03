import { describe, expect, it } from "vitest";

import { jwkThumbprint, signCompactJws, type PlexEd25519PublicJwk } from "./jwt.js";

/**
 * RFC 8037 Appendix A.3 — the RFC 7638 thumbprint algorithm's published
 * known-answer for an Ed25519 (OKP) key.
 *
 * The plan names RFC 7638 s.3.1, whose worked example is an RSA key. That key
 * cannot be handed to `jwkThumbprint`, which is typed `PlexEd25519PublicJwk`
 * by contract, so the OKP vector for the same algorithm is used instead. It was
 * cross-checked by deriving `x` from RFC 8037 A.1's private `d` with
 * `node:crypto`, and the RSA vector was separately confirmed to reproduce
 * `NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs` under the same canonicalization.
 */
const RFC_8037_PUBLIC_JWK: PlexEd25519PublicJwk = {
  kty: "OKP",
  crv: "Ed25519",
  x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
};
const RFC_8037_THUMBPRINT = "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k";

describe("jwkThumbprint", () => {
  it("reproduces the published RFC 7638 thumbprint for the RFC 8037 Ed25519 key", () => {
    expect(jwkThumbprint(RFC_8037_PUBLIC_JWK)).toBe(RFC_8037_THUMBPRINT);
  });
});

describe("signCompactJws", () => {
  it("rejects any algorithm other than EdDSA", () => {
    // The `alg` literal is pinned by the type, so an untyped caller is the only
    // way to reach the runtime guard this assertion exists to protect.
    const input = {
      protectedHeader: { kid: RFC_8037_THUMBPRINT, alg: "HS256", typ: "JWT" },
      payload: { iss: RFC_8037_THUMBPRINT },
      privateKeyPkcs8Pem: "unused — the guard runs before any key is parsed",
    } as unknown as Parameters<typeof signCompactJws>[0];

    expect(() => signCompactJws(input)).toThrow(TypeError);
  });
});
