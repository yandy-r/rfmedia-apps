/**
 * Shared `Retry-After` parsing and the wait caps that bound how long a caller
 * will honor a server-supplied delay.
 *
 * One parser, two consumers: the Lidarr transport/client (via the
 * `lidarr/errors.js` re-export, which keeps every historical importer working)
 * and the Plex account enrollment/refresh path (#251). Duplicating the parser
 * would let the two surfaces drift on what counts as a honorable delay.
 */

/**
 * Parse a `Retry-After` header in delta-seconds form.
 *
 * The HTTP-date form is intentionally not supported and yields `undefined`.
 * That is a real, recorded limitation rather than an oversight: every observed
 * `Retry-After` from Lidarr and from `clients.plex.tv` is delta-seconds, and
 * date parsing would make the wait depend on local clock accuracy. A server
 * that switches to the HTTP-date form degrades to the caller's own backoff
 * instead of to a wrong wait. Recorded in the #251 deferrals ADR.
 *
 * @param headerValue - Raw header value, or `null` when the header is absent.
 * @returns Non-negative seconds to wait, or `undefined` when unparseable.
 */
export function parseRetryAfter(headerValue: string | null): number | undefined {
  if (headerValue === null) {
    return undefined;
  }
  const seconds = Number(headerValue.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * Longest `Retry-After` delay a Plex account request will block on in-process.
 *
 * Mirrors the Lidarr precedent: `retryBackoffCapMs` (`src/types/config.ts:297`,
 * default 15_000) caps both retry backoff and honored `Retry-After` waits, and
 * `lidarr/scheduler.ts:416-418` abandons the retry outright once the advertised
 * wait exceeds the cap rather than sleeping for it. Plex applies the same rule:
 * at or under this cap the caller waits and retries once; above it the wait is
 * persisted as cooperative cross-process backoff and the command fails fast
 * with the remaining delay.
 */
export const PLEX_RETRY_AFTER_WAIT_CAP_SECONDS = 15;

/**
 * Upper bound on the cooperative refresh backoff persisted to the Plex
 * credential store.
 *
 * The measured `clients.plex.tv` limiter is 10 requests per 300 s, IP-scoped,
 * so a single advertised `Retry-After` never legitimately exceeds one period by
 * much. Clamping to 15 minutes keeps a hostile or buggy header from wedging
 * every rfmedia process on the host until the value is manually cleared.
 */
export const PLEX_REFRESH_BACKOFF_CAP_SECONDS = 900;
