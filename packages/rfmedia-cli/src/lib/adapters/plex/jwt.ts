/**
 * Ed25519 client key material and compact JWS signing for Plex enrollment.
 *
 * jose ADOPTION TRIP-WIRES (written here so the next reader of this file sees
 * them):
 *   (a) If scope ever grows to VERIFYING a Plex-issued JWT, or to consuming a
 *       JWKS endpoint, adopt `jose` immediately. Do not hand-roll verification.
 *   (b) If more than one algorithm or key type becomes necessary, adopt `jose`.
 * Today rfmedia only ever SIGNS a token it created, with one algorithm, one
 * curve, one serialization. `node:crypto` Ed25519 emits the RFC 8037 s.3.1
 * 64-byte raw signature by construction (verified on Node 22.22.2 and 25.9.0).
 *
 * @module
 */

import { createPrivateKey, generateKeyPair, createHash, sign } from "node:crypto";
import { promisify } from "node:util";

const generateKeyPairAsync = promisify(generateKeyPair);

/** RFC 8037 s.2 public JWK for the single curve this module supports. */
export interface PlexEd25519PublicJwk {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
}

/** Client key material persisted by the credential store. */
export interface PlexClientKeyPair {
  /** RFC 7638 thumbprint, 43 chars base64url. Non-secret. Changes on rotation. */
  readonly kid: string;
  readonly publicJwk: PlexEd25519PublicJwk;
  readonly privateKeyPkcs8Pem: string;
}

/**
 * Encodes bytes or UTF-8 text as unpadded base64url (RFC 7515 Appendix C).
 *
 * @param value - Raw bytes or a UTF-8 string.
 * @returns The unpadded base64url serialization.
 */
function toBase64Url(value: Buffer | string): string {
  return (typeof value === "string" ? Buffer.from(value, "utf8") : value).toString("base64url");
}

/**
 * Generates a fresh Ed25519 client key pair with its RFC 7638 thumbprint.
 *
 * The private key never leaves this process except through the caller's
 * owner-only credential store; nothing here touches the filesystem.
 *
 * @returns The key pair with `kid`, public JWK, and PKCS#8 PEM private key.
 * @throws TypeError when Node returns a JWK missing the RFC 8037 members.
 */
export async function generatePlexClientKeyPair(): Promise<PlexClientKeyPair> {
  const { publicKey, privateKey } = await generateKeyPairAsync("ed25519");
  const exported = publicKey.export({ format: "jwk" });

  if (exported.kty !== "OKP" || exported.crv !== "Ed25519" || typeof exported.x !== "string") {
    throw new TypeError("Node produced a non-Ed25519 public JWK for a generated ed25519 key");
  }

  const publicJwk: PlexEd25519PublicJwk = Object.freeze({
    kty: "OKP",
    crv: "Ed25519",
    x: exported.x,
  });

  return Object.freeze({
    kid: jwkThumbprint(publicJwk),
    publicJwk,
    privateKeyPkcs8Pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  });
}

/**
 * Computes the RFC 7638 JWK thumbprint of an Ed25519 public JWK.
 *
 * The canonical form contains exactly the RFC 8037 s.2 required members
 * (`crv`, `kty`, `x`) in lexicographic order with no whitespace. A wrong
 * thumbprint yields a `kid` plex.tv never matches, so enrollment fails with an
 * opaque server-side error; the known-answer test in `jwt.test.ts` is the only
 * local defence against that.
 *
 * @param jwk - Public JWK whose thumbprint is required.
 * @returns The SHA-256 thumbprint as 43 characters of unpadded base64url.
 * @throws TypeError when the JWK is not a well-formed Ed25519 public JWK.
 */
export function jwkThumbprint(jwk: PlexEd25519PublicJwk): string {
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
    throw new TypeError("Plex client JWK must be an Ed25519 OKP key");
  }
  if (typeof jwk.x !== "string" || jwk.x.length === 0) {
    throw new TypeError("Plex client JWK is missing its public key coordinate");
  }

  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return toBase64Url(createHash("sha256").update(canonical, "utf8").digest());
}

/**
 * Signs a compact JWS with EdDSA over Ed25519.
 *
 * `sign(null, …)` is deliberate: OpenSSL rejects a digest argument on Ed25519,
 * and the resulting 64-byte raw signature is already the RFC 8037 s.3.1 form.
 *
 * @param input - Protected header, payload claims, and the PKCS#8 PEM key.
 * @returns The three-part compact JWS serialization.
 * @throws TypeError when `alg !== "EdDSA"`.
 */
export function signCompactJws(input: {
  readonly protectedHeader: { readonly kid: string; readonly alg: "EdDSA"; readonly typ: "JWT" };
  readonly payload: Readonly<Record<string, unknown>>;
  readonly privateKeyPkcs8Pem: string;
}): string {
  const { protectedHeader, payload, privateKeyPkcs8Pem } = input;

  if (protectedHeader.alg !== "EdDSA") {
    throw new TypeError("Plex client assertions must be signed with EdDSA");
  }

  const signingInput = `${toBase64Url(JSON.stringify(protectedHeader))}.${toBase64Url(
    JSON.stringify(payload),
  )}`;
  const privateKey = createPrivateKey({ key: privateKeyPkcs8Pem, format: "pem", type: "pkcs8" });
  const signature = sign(null, Buffer.from(signingInput, "utf8"), privateKey);

  return `${signingInput}.${toBase64Url(signature)}`;
}
