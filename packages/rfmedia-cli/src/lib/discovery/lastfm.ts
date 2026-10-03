/**
 * Fixed-origin Last.fm similar-artist transport and strict wire projection.
 *
 * This module is the sole owner of credential-bearing Last.fm Fetch calls.
 * It performs one request per invocation; the shared scheduler owns retries.
 */

import type { LastFmConfigOptions } from "../../types/config.js";
import {
  isCanonicalMusicBrainzId,
  type DiscoveryProviderFailure,
  type DiscoveryProviderFailureCode,
  type LastFmClient,
  type LastFmSimilarArtist,
  type LastFmSimilarArtistQuery,
  type LastFmSimilarArtistResult,
} from "../../types/discovery.js";

const LASTFM_ENDPOINT = "https://ws.audioscrobbler.com/2.0/";
const LASTFM_CATALOGUE_ORIGIN = "https://www.last.fm";
const LASTFM_SITE_URL = "https://www.last.fm/" as const;
const LASTFM_METHOD = "artist.getSimilar" as const;
const LASTFM_ATTRIBUTION = "Recommendations provided by Last.fm" as const;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SUCCESS_BODY_BYTES = 1024 * 1024;
const DEFAULT_ERROR_BODY_BYTES = 4 * 1024;
const MAX_TIMEOUT_MS = 300_000;
const MAX_ARTISTS = 100;
const MAX_API_KEY_UTF8_BYTES = 1_024;
const MAX_QUERY_NAME_CODE_POINTS = 256;
const MAX_QUERY_NAME_UTF8_BYTES = 1_024;
const MAX_ARTIST_NAME_CODE_POINTS = 512;
const MAX_ARTIST_NAME_UTF8_BYTES = 2 * 1_024;
const MAX_CATALOGUE_URL_LENGTH = 2_048;
const UNSAFE_TEXT_PATTERN = /[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/u;

type FetchImplementation = typeof fetch;

/** Test seams and fixed resource bounds for the Last.fm boundary. */
export interface LastFmClientDependencies {
  /** Trusted network Fetch implementation. */
  readonly fetch?: FetchImplementation;
  /** Clock used for mandatory attribution timestamps. */
  readonly now?: () => Date;
  /** Timer seam used by deterministic timeout tests. */
  readonly scheduleTimeout?: (callback: () => void, milliseconds: number) => unknown;
  /** Timer cleanup seam paired with `scheduleTimeout`. */
  readonly cancelTimeout?: (handle: unknown) => void;
  /** Success-body limit; defaults to 1 MiB. */
  readonly maxSuccessBodyBytes?: number;
  /** Error-body drain limit; defaults to 4 KiB. */
  readonly maxErrorBodyBytes?: number;
}

interface AbortComposition {
  readonly signal: AbortSignal;
  didTimeout(): boolean;
  cleanup(): void;
}

interface LastFmProviderErrorOptions {
  readonly statusCode?: number;
  readonly retryAfterSeconds?: number;
}

class BodyLimitError extends Error {
  override readonly name = "BodyLimitError";
}

class InvalidBodyError extends Error {
  override readonly name = "InvalidBodyError";
}

/**
 * Sanitized provider failure consumed structurally by the shared scheduler.
 *
 * The class never retains a request URL, response body, Fetch error, or cause,
 * because all of those values may contain the query-string API key.
 */
export class LastFmProviderError extends Error implements DiscoveryProviderFailure {
  override readonly name = "LastFmProviderError";
  readonly code: DiscoveryProviderFailureCode;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly retryAfterSeconds?: number;

  /**
   * Creates one secret-safe provider failure.
   *
   * @param code - Stable discovery failure classification.
   * @param message - Constant, credential-free failure description.
   * @param retryable - Whether an idempotent discovery task may retry.
   * @param options - Safe HTTP and retry-delay metadata.
   */
  constructor(
    code: DiscoveryProviderFailureCode,
    message: string,
    retryable: boolean,
    options: LastFmProviderErrorOptions = {},
  ) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.statusCode = options.statusCode;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

function defaultScheduleTimeout(callback: () => void, milliseconds: number): unknown {
  return setTimeout(callback, milliseconds);
}

function defaultCancelTimeout(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function validatePositiveLimit(name: string, value: number, maximum?: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || (maximum !== undefined && value > maximum)) {
    throw new TypeError(
      `${name} must be a positive safe integer${maximum === undefined ? "" : ` at most ${maximum}`}`,
    );
  }
  return value;
}

function configurationError(): LastFmProviderError {
  return new LastFmProviderError(
    "configuration",
    "Last.fm API key is unavailable or invalid at discovery.lastfm.apiKey",
    false,
  );
}

function invalidResponse(message = "Last.fm returned an invalid response"): LastFmProviderError {
  return new LastFmProviderError("invalid-response", message, false);
}

function callerAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Last.fm request was cancelled", "AbortError");
}

function composeAbortSignals(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  scheduleTimeout: (callback: () => void, milliseconds: number) => unknown,
  cancelTimeout: (handle: unknown) => void,
): AbortComposition {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = (): void => {
    if (callerSignal !== undefined) controller.abort(callerAbortReason(callerSignal));
  };

  if (callerSignal?.aborted === true) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

  const timeoutHandle = scheduleTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Last.fm request timed out", "TimeoutError"));
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

function raceAbort<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(callerAbortReason(signal));
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = (): void => rejectPromise(callerAbortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        rejectPromise(error);
      },
    );
  });
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let cancelled = false;
  try {
    while (true) {
      const result = await raceAbort(reader.read(), signal);
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > maximumBytes) {
        cancelled = true;
        await raceAbort(reader.cancel("response body limit exceeded"), signal).catch(() => {});
        throw new BodyLimitError("Last.fm response exceeded its configured body limit");
      }
      chunks.push(result.value);
    }
  } catch (error: unknown) {
    if (!cancelled) await raceAbort(reader.cancel(error), signal).catch(() => {});
    throw error;
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

function decodeJson(body: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new InvalidBodyError("Last.fm response is not valid UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InvalidBodyError("Last.fm response is not valid JSON");
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBoundedText(
  value: unknown,
  maximumCodePoints: number,
  maximumUtf8Bytes: number,
): string | undefined {
  if (typeof value !== "string" || UNSAFE_TEXT_PATTERN.test(value)) return undefined;
  const normalized = value.trim().normalize("NFC");
  if (
    normalized.length === 0 ||
    [...normalized].length > maximumCodePoints ||
    Buffer.byteLength(normalized, "utf8") > maximumUtf8Bytes
  ) {
    return undefined;
  }
  return normalized;
}

function normalizeQuery(query: LastFmSimilarArtistQuery): LastFmSimilarArtistQuery {
  const artist = normalizeBoundedText(
    query.artist,
    MAX_QUERY_NAME_CODE_POINTS,
    MAX_QUERY_NAME_UTF8_BYTES,
  );
  if (
    artist === undefined ||
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > MAX_ARTISTS ||
    typeof query.autocorrect !== "boolean"
  ) {
    throw new LastFmProviderError("validation", "Last.fm similar-artist query is invalid", false);
  }
  return Object.freeze({
    artist,
    limit: query.limit,
    autocorrect: query.autocorrect,
    ...(query.signal === undefined ? {} : { signal: query.signal }),
  });
}

function parseSimilarity(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const similarity = typeof value === "number" ? value : Number(value);
  return Number.isFinite(similarity) && similarity >= 0 && similarity <= 1 ? similarity : undefined;
}

function parseMusicBrainzId(value: unknown): string | undefined | null {
  // Last.fm omits `mbid` for some artists; treat missing/null like empty string.
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized === "") return undefined;
  return isCanonicalMusicBrainzId(normalized) ? normalized.toLowerCase() : null;
}

function parseCatalogueUrl(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > MAX_CATALOGUE_URL_LENGTH ||
    UNSAFE_TEXT_PATTERN.test(value)
  ) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== LASTFM_CATALOGUE_ORIGIN ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.pathname.startsWith("/music/")
  ) {
    return undefined;
  }
  return url.href;
}

function parseArtist(value: unknown): LastFmSimilarArtist {
  if (!isRecord(value)) throw invalidResponse();
  const name = normalizeBoundedText(
    value["name"],
    MAX_ARTIST_NAME_CODE_POINTS,
    MAX_ARTIST_NAME_UTF8_BYTES,
  );
  const similarity = parseSimilarity(value["match"]);
  const musicBrainzId = parseMusicBrainzId(value["mbid"]);
  const sourceUrl = parseCatalogueUrl(value["url"]);
  if (
    name === undefined ||
    similarity === undefined ||
    musicBrainzId === null ||
    sourceUrl === undefined
  ) {
    throw invalidResponse();
  }
  return Object.freeze({
    name,
    similarity,
    ...(musicBrainzId === undefined ? {} : { musicBrainzId }),
    sourceUrl,
  });
}

function parseLogicalErrorCode(payload: Readonly<Record<string, unknown>>): number | undefined {
  if (!Object.hasOwn(payload, "error")) return undefined;
  const value = payload["error"];
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalidResponse();
  return value as number;
}

function logicalError(
  code: number,
  statusCode: number,
  retryAfterSeconds: number | undefined,
): LastFmProviderError {
  const options = {
    statusCode,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
  switch (code) {
    case 11:
    case 16:
      return new LastFmProviderError(
        "discovery-provider-unavailable",
        `Last.fm is temporarily unavailable (API error ${code})`,
        true,
        options,
      );
    case 29:
      return new LastFmProviderError("rate-limited", "Last.fm rate limit exceeded", true, options);
    case 4:
    case 26:
      return new LastFmProviderError(
        "authorization",
        `Last.fm authorization failed (API error ${code})`,
        false,
        options,
      );
    case 9:
    case 13:
      return new LastFmProviderError(
        "authentication",
        `Last.fm authentication failed (API error ${code})`,
        false,
        options,
      );
    case 10:
      return new LastFmProviderError(
        "configuration",
        "Last.fm API key is invalid at discovery.lastfm.apiKey",
        false,
        options,
      );
    case 2:
    case 3:
    case 5:
    case 6:
    case 7:
    case 8:
      return new LastFmProviderError(
        "validation",
        `Last.fm rejected the similar-artist request (API error ${code})`,
        false,
        options,
      );
    default:
      return invalidResponse("Last.fm returned an unknown API error");
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || !/^(?:0|[1-9]\d*)$/u.test(value.trim())) return undefined;
  const seconds = Number(value.trim());
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

function httpError(statusCode: number, retryAfterSeconds: number | undefined): LastFmProviderError {
  const options = {
    statusCode,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
  if (statusCode === 401) {
    return new LastFmProviderError(
      "authentication",
      "Last.fm authentication failed (HTTP 401)",
      false,
      options,
    );
  }
  if (statusCode === 403) {
    return new LastFmProviderError(
      "authorization",
      "Last.fm authorization failed (HTTP 403)",
      false,
      options,
    );
  }
  if (statusCode === 429) {
    return new LastFmProviderError(
      "rate-limited",
      "Last.fm rate limit exceeded (HTTP 429)",
      true,
      options,
    );
  }
  if (statusCode >= 500) {
    return new LastFmProviderError(
      "discovery-provider-unavailable",
      `Last.fm is temporarily unavailable (HTTP ${statusCode})`,
      true,
      options,
    );
  }
  if (statusCode === 400 || statusCode === 404) {
    return new LastFmProviderError(
      "validation",
      `Last.fm rejected the similar-artist request (HTTP ${statusCode})`,
      false,
      options,
    );
  }
  return invalidResponse(`Last.fm returned unexpected HTTP ${statusCode}`);
}

function projectResult(
  payload: unknown,
  query: LastFmSimilarArtistQuery,
  fetchedAt: string,
): LastFmSimilarArtistResult {
  if (!isRecord(payload) || !isRecord(payload["similarartists"])) throw invalidResponse();
  const similarArtists = payload["similarartists"];
  const attributes = similarArtists["@attr"];
  const rawArtists = similarArtists["artist"];
  if (!isRecord(attributes) || !Array.isArray(rawArtists)) throw invalidResponse();
  const resolvedName = normalizeBoundedText(
    attributes["artist"],
    MAX_QUERY_NAME_CODE_POINTS,
    MAX_QUERY_NAME_UTF8_BYTES,
  );
  if (
    resolvedName === undefined ||
    rawArtists.length > query.limit ||
    rawArtists.length > MAX_ARTISTS
  ) {
    throw invalidResponse();
  }
  const recommendations = Object.freeze(rawArtists.map(parseArtist));
  const source = Object.freeze({
    provider: "lastfm" as const,
    method: LASTFM_METHOD,
    attribution: LASTFM_ATTRIBUTION,
    url: LASTFM_SITE_URL,
    fetchedAt,
  });
  return Object.freeze({
    requestedName: query.artist,
    resolvedName,
    autocorrected: resolvedName !== query.artist,
    recommendations,
    source,
  });
}

function throwMappedFailure(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  abort: AbortComposition,
): never {
  if (error instanceof LastFmProviderError) throw error;
  if (callerSignal?.aborted === true) throw callerAbortReason(callerSignal);
  if (abort.didTimeout()) {
    throw new LastFmProviderError("timeout", "Last.fm request timed out", true);
  }
  if (error instanceof BodyLimitError) {
    throw invalidResponse("Last.fm response exceeded the allowed size");
  }
  if (error instanceof InvalidBodyError) throw invalidResponse();
  throw new LastFmProviderError(
    "discovery-provider-unavailable",
    "Last.fm is temporarily unavailable",
    true,
  );
}

/**
 * Creates the sole fixed-origin Last.fm client.
 *
 * @param config - Validated discovery configuration containing the API key and timeout.
 * @param dependencies - Optional deterministic Fetch, clock, timer, and body-limit seams.
 * @returns A frozen client that performs one strict `artist.getSimilar` request per call.
 * @throws {LastFmProviderError} When configuration is unsafe or the provider request fails.
 */
export function createLastFmClient(
  config: LastFmConfigOptions,
  dependencies: LastFmClientDependencies = {},
): LastFmClient {
  const apiKey = config.apiKey;
  if (
    typeof apiKey !== "string" ||
    apiKey.trim().length === 0 ||
    Buffer.byteLength(apiKey, "utf8") > MAX_API_KEY_UTF8_BYTES ||
    UNSAFE_TEXT_PATTERN.test(apiKey)
  ) {
    throw configurationError();
  }
  const timeoutMs = validatePositiveLimit(
    "discovery.lastfm.timeoutMs",
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
  const maximumSuccessBytes = validatePositiveLimit(
    "maxSuccessBodyBytes",
    dependencies.maxSuccessBodyBytes ?? DEFAULT_SUCCESS_BODY_BYTES,
  );
  const maximumErrorBytes = validatePositiveLimit(
    "maxErrorBodyBytes",
    dependencies.maxErrorBodyBytes ?? DEFAULT_ERROR_BODY_BYTES,
  );
  const trustedFetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const now = dependencies.now ?? (() => new Date());
  const scheduleTimeout = dependencies.scheduleTimeout ?? defaultScheduleTimeout;
  const cancelTimeout = dependencies.cancelTimeout ?? defaultCancelTimeout;

  return Object.freeze({
    getSimilarArtists: async (
      untrustedQuery: LastFmSimilarArtistQuery,
    ): Promise<LastFmSimilarArtistResult> => {
      const query = normalizeQuery(untrustedQuery);
      if (query.signal?.aborted === true) throw callerAbortReason(query.signal);
      const url = new URL(LASTFM_ENDPOINT);
      url.search = new URLSearchParams({
        method: LASTFM_METHOD,
        artist: query.artist,
        limit: String(query.limit),
        autocorrect: query.autocorrect ? "1" : "0",
        api_key: apiKey,
        format: "json",
      }).toString();
      const abort = composeAbortSignals(query.signal, timeoutMs, scheduleTimeout, cancelTimeout);

      try {
        if (abort.signal.aborted) throw callerAbortReason(abort.signal);
        const response = await raceAbort(
          trustedFetch(url, {
            method: "GET",
            headers: { accept: "application/json" },
            redirect: "error",
            signal: abort.signal,
          }),
          abort.signal,
        );
        const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));

        if (!response.ok) {
          let payload: unknown;
          try {
            payload = decodeJson(await readBoundedBody(response, maximumErrorBytes, abort.signal));
          } catch (error: unknown) {
            if (!(error instanceof BodyLimitError) && !(error instanceof InvalidBodyError)) {
              throw error;
            }
          }
          if (isRecord(payload)) {
            const logicalCode = parseLogicalErrorCode(payload);
            if (logicalCode !== undefined) {
              throw logicalError(logicalCode, response.status, retryAfterSeconds);
            }
          }
          throw httpError(response.status, retryAfterSeconds);
        }

        const payload = decodeJson(
          await readBoundedBody(response, maximumSuccessBytes, abort.signal),
        );
        if (!isRecord(payload)) throw invalidResponse();
        const logicalCode = parseLogicalErrorCode(payload);
        if (logicalCode !== undefined) {
          throw logicalError(logicalCode, response.status, retryAfterSeconds);
        }
        const fetchedAt = now().toISOString();
        return projectResult(payload, query, fetchedAt);
      } catch (error: unknown) {
        throwMappedFailure(error, query.signal, abort);
      } finally {
        abort.cleanup();
      }
    },
  });
}
