/** A successfully parsed HTTP(S) URL and its canonical representations. */
export interface NormalizedHttpUrl {
  /** Parsed URL for callers that need to inspect connection components. */
  readonly parsed: URL;
  /** Canonical absolute URL, including any path, query, and fragment. */
  readonly href: string;
  /** Canonical origin, including non-default ports. */
  readonly origin: string;
}

/** Why an input could not be normalized as an HTTP(S) URL. */
export type HttpUrlNormalizationFailureReason = "invalid-url" | "unsupported-protocol";

/** Result of parsing and normalizing an HTTP(S) URL. */
export type HttpUrlNormalizationResult =
  | { readonly ok: true; readonly value: NormalizedHttpUrl }
  | { readonly ok: false; readonly reason: HttpUrlNormalizationFailureReason };

/**
 * Parses an absolute HTTP(S) URL without applying network-address policy.
 *
 * Loopback, LAN, and link-local targets are valid formats here because rfmedia
 * commonly connects directly to a self-hosted media server. Callers remain
 * responsible for any context-specific origin or component restrictions.
 */
export function normalizeHttpUrl(value: string): HttpUrlNormalizationResult {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: "invalid-url" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "unsupported-protocol" };
  }

  return {
    ok: true,
    value: {
      parsed,
      href: parsed.href,
      origin: parsed.origin,
    },
  };
}
