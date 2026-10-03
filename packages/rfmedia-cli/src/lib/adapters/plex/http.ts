/**
 * Shared HTTP primitives for the private Plex adapter directory.
 *
 * Both Plex HTTP owners — the PMS transport (`client.ts`) and the plex.tv
 * enrollment transport (`enrollment-client.ts`) — need the same bounded-body
 * reader, abort composition, and message sanitizer. Keeping one copy here means
 * a hardening applied to redaction cannot be applied to one transport and
 * silently missed on the other.
 *
 * This module performs no IO of its own: it never calls `fetch`, never reads a
 * clock, and never touches the filesystem.
 */

/**
 * Matches terminal control characters and Unicode bidirectional-override
 * codepoints, so a server-supplied byte sequence cannot reorder or overwrite
 * terminal output.
 *
 * The codepoint ranges are identical to `src/lib/redact-error-message.ts`; that
 * module is the reference implementation, and `plex/types.ts` deliberately keeps
 * an enumerated bidi class instead. Any widening belongs in both places.
 */
const CONTROL_CHARACTER_PATTERN = /[\x00-\x1f\x7f-\x9f]|\p{Bidi_Control}/gu;

/**
 * Matches `key: value` / `key=value` pairs whose key names authentication
 * material.
 *
 * The `[\w-]*` boundaries replace the original `\b…\b` anchors: `\btoken\b` does
 * NOT match `refresh_token` or `auth_token` because `_` is a word character, so
 * word-boundary anchoring silently skipped the exact JWT-era key names this
 * adapter now handles.
 */
const SENSITIVE_KEY_VALUE_PATTERN =
  /[\w-]*(?:x-plex-token|authorization|token|jwt|nonce|privatekey|pincode|code|secret|signature|assertion|refresh|devicejwt)[\w-]*\s*[:=]\s*[^\s,;]+/giu;

/** Upper bound on a sanitized message, applied after every redaction stage. */
const MAX_SANITIZED_MESSAGE_LENGTH = 512;

/** The literal substituted for every redacted secret or key/value pair. */
const REDACTION_MARKER = "[REDACTED]";

/**
 * Raised when a response body exceeds the caller's configured byte budget.
 *
 * Distinguished from a transport failure so callers can report an oversized
 * payload rather than a network error.
 */
export class BodyLimitError extends Error {
  override readonly name = "BodyLimitError";
}

/**
 * A caller signal and a request timeout collapsed into a single `AbortSignal`.
 *
 * `didTimeout()` distinguishes a timeout-driven abort from a caller-driven one
 * so the transport can classify the failure; `cleanup()` must run on every exit
 * path to release the timer and the caller's `abort` listener.
 */
export interface AbortComposition {
  readonly signal: AbortSignal;
  didTimeout(): boolean;
  cleanup(): void;
}

/**
 * Reports whether an optional signal has already been aborted.
 *
 * @param signal - The caller-supplied signal, when one was provided.
 * @returns `true` only when a signal exists and is aborted.
 */
export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Resolves the reason to propagate when a caller cancels a request.
 *
 * @param signal - The caller-supplied signal, when one was provided.
 * @returns The signal's own reason, or a synthesized `AbortError` when the
 *   caller aborted without one.
 */
export function callerAbortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("Plex request was cancelled", "AbortError");
}

/**
 * Converts an arbitrary failure into a bounded, terminal-safe message with
 * every known secret removed.
 *
 * Redaction runs in three stages, always before truncation:
 *
 * 1. exact removal of every caller-supplied secret,
 * 2. removal of `key: value` pairs whose key names authentication material,
 * 3. stripping of control and bidirectional-override characters.
 *
 * `secrets` is a `readonly string[]` rather than `Iterable<string>` on purpose:
 * `string` itself satisfies `Iterable<string>`, so an iterable signature would
 * let a bare-`string` call site compile while redacting every individual
 * character instead of the token. The array type turns that mistake into a
 * compile error. Pass `[]` for the no-secrets case.
 *
 * The secrets array is also what makes post-rotation redaction possible: after a
 * credential rotates, the previous JWT is still a live in-memory secret that a
 * single-token sanitizer would know nothing about.
 *
 * @param value - The failure to describe; `Error` instances contribute their
 *   `message`, anything else is stringified.
 * @param secrets - Every credential currently considered live. Empty strings are
 *   ignored.
 * @returns A message of at most 512 characters containing no supplied secret,
 *   no sensitive key/value pair, and no terminal control sequence.
 */
export function sanitizeMessage(value: unknown, secrets: readonly string[]): string {
  let message = value instanceof Error ? value.message : String(value);

  for (const secret of secrets) {
    if (secret.length > 0) {
      message = message.split(secret).join(REDACTION_MARKER);
    }
  }

  message = message
    .replace(SENSITIVE_KEY_VALUE_PATTERN, REDACTION_MARKER)
    .replace(CONTROL_CHARACTER_PATTERN, " ")
    .trim();

  return message.slice(0, MAX_SANITIZED_MESSAGE_LENGTH);
}

/**
 * Combines an optional caller signal with a request timeout.
 *
 * The returned signal aborts when either input aborts. A caller abort forwards
 * the caller's own reason; the timeout aborts with a `TimeoutError` so the two
 * causes stay distinguishable.
 *
 * @param callerSignal - The caller's cancellation signal, when one was provided.
 * @param timeoutMs - Milliseconds before the composed signal times out.
 * @param scheduleTimeout - Timer seam; returns an opaque handle.
 * @param cancelTimeout - Timer seam; cancels a handle from `scheduleTimeout`.
 * @returns The composed signal plus its timeout predicate and cleanup hook.
 */
export function composeAbortSignals(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  scheduleTimeout: (callback: () => void, milliseconds: number) => unknown,
  cancelTimeout: (handle: unknown) => void,
): AbortComposition {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = (): void => {
    controller.abort(callerAbortReason(callerSignal));
  };

  if (callerSignal?.aborted === true) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  const timeoutHandle = scheduleTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Plex request timed out", "TimeoutError"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      cancelTimeout(timeoutHandle);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

/**
 * Streams a response body while enforcing a hard byte ceiling.
 *
 * The limit is checked per chunk, so an unbounded or hostile response is
 * cancelled instead of being buffered to exhaustion.
 *
 * @param response - The response whose body should be drained.
 * @param maximumBytes - The inclusive byte budget for the whole body.
 * @returns The complete body bytes, or an empty array when there was no body.
 * @throws BodyLimitError When the accumulated body exceeds `maximumBytes`.
 */
export async function readBoundedBody(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (response.body === null) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel("response body limit exceeded");
        throw new BodyLimitError("Plex response exceeded the configured body limit");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
