import { normalizeHttpUrl } from "./http-url.js";

/**
 * Normalizes a raw Plex server URL down to its bare origin.
 *
 * This is the **single origin-normalization authority** shared by the media
 * server adapter resolver (which uses it for the cross-origin credential guard)
 * and the Plex enrollment verbs (`plex auth login|refresh|logout|status`).
 * Both sides must agree byte-for-byte on what "the same Plex origin" means: a
 * looser rule here weakens the cross-origin guard, and a stricter one makes a
 * working enrollment resolve as `not-enrolled`. Never re-implement or copy this
 * function — import it.
 *
 * A value is rejected (returns `undefined`) when it is not a valid `http:` or
 * `https:` URL, or when it carries anything beyond scheme, host, and port:
 * credentials, a non-root path, a query string, or a fragment.
 *
 * @param value - Raw Plex server URL, typically from `--plex-url` or `plex.url`.
 * @returns The normalized origin (e.g. `http://localhost:32400`), or `undefined`
 *   when the value is not an acceptable bare Plex origin.
 */
export function normalizePlexOrigin(value: string): string | undefined {
  const normalized = normalizeHttpUrl(value);
  if (!normalized.ok) {
    return undefined;
  }

  const { parsed, href, origin } = normalized.value;
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    href.includes("?") ||
    href.includes("#")
  ) {
    return undefined;
  }
  return origin;
}
