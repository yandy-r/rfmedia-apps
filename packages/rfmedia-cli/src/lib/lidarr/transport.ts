import {
  LidarrError,
  LidarrTimeoutError,
  LidarrUnreachableError,
  LidarrValidationError,
  classifyLidarrStatus,
  parseRetryAfter,
} from "./errors.js";
import type { LidarrApiKeyProvider, LidarrConnectionSettings } from "./types.js";

const DEFAULT_SUCCESS_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_ERROR_BODY_BYTES = 4 * 1024;
const SENSITIVE_QUERY_KEY_PATTERN = /(?:api-?key|authorization|token|jwt|nonce|privatekey)/iu;
const SENSITIVE_QUERY_VALUE_PATTERN =
  /(?:^|\s)(?:basic|bearer)\s|(?:api-?key|authorization|jwt|token)/iu;
const SENSITIVE_HEADER_PATTERN =
  /(?:api-?key|authorization|cookie|jwt|proxy-authorization|token)/iu;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

type FetchImplementation = typeof fetch;
type FetchInput = Parameters<FetchImplementation>[0];
type FetchInit = Parameters<FetchImplementation>[1];

/** Test seams and fixed policy inputs for one private generated-client transport. */
export interface LidarrTransportDependencies {
  /** Stable action label attached to typed errors. */
  readonly operation?: string;
  /** Concurrency-safe operation context owned by the facade. */
  readonly getOperation?: () => string | undefined;
  /** Trusted network Fetch implementation. */
  readonly fetch?: FetchImplementation;
  /** Existing post-response pacing seam. */
  readonly delay?: (milliseconds: number) => Promise<void>;
  /** Timer seam used by deterministic timeout tests. */
  readonly scheduleTimeout?: (callback: () => void, milliseconds: number) => unknown;
  /** Timer cleanup seam paired with `scheduleTimeout`. */
  readonly cancelTimeout?: (handle: unknown) => void;
  /** Success-body limit; defaults to 8 MiB. */
  readonly maxSuccessBodyBytes?: number;
  /** Error-body drain limit; defaults to 4 KiB. */
  readonly maxErrorBodyBytes?: number;
}

interface AbortComposition {
  readonly signal: AbortSignal;
  didTimeout(): boolean;
  cleanup(): void;
}

class BodyLimitError extends Error {
  override readonly name = "BodyLimitError";
}

class InvalidBodyError extends Error {
  override readonly name = "InvalidBodyError";
}

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function defaultScheduleTimeout(callback: () => void, milliseconds: number): unknown {
  return setTimeout(callback, milliseconds);
}

function defaultCancelTimeout(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function validatePositiveLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function validateNonNegativeLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function callerAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Lidarr request was cancelled", "AbortError");
}

function composeAbortSignals(
  callerSignal: AbortSignal,
  timeoutMs: number,
  scheduleTimeout: (callback: () => void, milliseconds: number) => unknown,
  cancelTimeout: (handle: unknown) => void,
): AbortComposition {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = (): void => controller.abort(callerAbortReason(callerSignal));

  if (callerSignal.aborted) abortFromCaller();
  else callerSignal.addEventListener("abort", abortFromCaller, { once: true });

  const timeoutHandle = scheduleTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Lidarr request timed out", "TimeoutError"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      cancelTimeout(timeoutHandle);
      callerSignal.removeEventListener("abort", abortFromCaller);
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

function invalidConfiguration(operation: string): LidarrValidationError {
  return new LidarrValidationError(
    operation,
    "Invalid Lidarr request configuration",
    "configuration",
  );
}

function invalidResponse(operation: string, oversized: boolean): LidarrValidationError {
  return new LidarrValidationError(
    operation,
    oversized
      ? "Lidarr response exceeded the allowed size"
      : "Lidarr returned an invalid JSON response",
    "invalid-response",
  );
}

function validateRequestBeforeCredential(
  input: FetchInput,
  init: FetchInit,
  connection: LidarrConnectionSettings,
  operation: string,
): Request {
  if (!(input instanceof Request) || init !== undefined) throw invalidConfiguration(operation);
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw invalidConfiguration(operation);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.origin !== connection.origin ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw invalidConfiguration(operation);
  }
  for (const [key, value] of url.searchParams) {
    if (SENSITIVE_QUERY_KEY_PATTERN.test(key) || SENSITIVE_QUERY_VALUE_PATTERN.test(value)) {
      throw invalidConfiguration(operation);
    }
  }
  for (const key of input.headers.keys()) {
    if (SENSITIVE_HEADER_PATTERN.test(key)) throw invalidConfiguration(operation);
  }
  return input;
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
        throw new BodyLimitError("Lidarr response exceeded the configured body limit");
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

function validateUtf8(body: Uint8Array): void {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new InvalidBodyError("Lidarr response is not valid UTF-8");
  }
}

function reconstructResponse(response: Response, body: Uint8Array): Response {
  const headers = new Headers({ "content-type": "application/json" });
  headers.set("content-length", String(body.byteLength));
  return new Response(response.status === 204 || response.status === 205 ? null : body, {
    headers,
    status: response.status,
  });
}

function throwMappedFailure(
  error: unknown,
  operation: string,
  callerSignal: AbortSignal,
  abort: AbortComposition,
): never {
  if (error instanceof LidarrError) throw error;
  if (callerSignal.aborted) throw callerAbortReason(callerSignal);
  if (abort.didTimeout()) throw new LidarrTimeoutError(operation);
  if (error instanceof BodyLimitError) throw invalidResponse(operation, true);
  if (error instanceof InvalidBodyError) throw invalidResponse(operation, false);
  throw new LidarrUnreachableError(operation);
}

/**
 * Creates the sole authenticated network boundary used by a generated Lidarr client.
 * The returned Fetch accepts only the generated runtime's final `Request`.
 */
export function createLidarrTransport(
  connection: LidarrConnectionSettings,
  apiKeyProvider: LidarrApiKeyProvider,
  dependencies: LidarrTransportDependencies = {},
): FetchImplementation {
  const fallbackOperation = dependencies.operation ?? "lidarr request";
  const trustedFetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const delay = dependencies.delay ?? defaultDelay;
  const scheduleTimeout = dependencies.scheduleTimeout ?? defaultScheduleTimeout;
  const cancelTimeout = dependencies.cancelTimeout ?? defaultCancelTimeout;
  const maxSuccessBodyBytes = validatePositiveLimit(
    "maxSuccessBodyBytes",
    dependencies.maxSuccessBodyBytes ?? DEFAULT_SUCCESS_BODY_BYTES,
  );
  const maxErrorBodyBytes = validatePositiveLimit(
    "maxErrorBodyBytes",
    dependencies.maxErrorBodyBytes ?? DEFAULT_ERROR_BODY_BYTES,
  );
  validatePositiveLimit("timeoutMs", connection.request.timeoutMs);
  validateNonNegativeLimit("delayMs", connection.request.delayMs);

  return async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const contextualOperation = dependencies.getOperation?.();
    const operation =
      typeof contextualOperation === "string" && contextualOperation.length > 0
        ? contextualOperation
        : fallbackOperation;
    const request = validateRequestBeforeCredential(input, init, connection, operation);
    if (request.signal.aborted) throw callerAbortReason(request.signal);

    let apiKey: string;
    try {
      apiKey = await apiKeyProvider.getApiKey();
      if (apiKey.length === 0 || CONTROL_CHARACTER_PATTERN.test(apiKey)) throw new TypeError();
    } catch {
      throw new LidarrValidationError(
        operation,
        "Lidarr API key is unavailable or invalid",
        "configuration",
      );
    }
    const url = new URL(request.url);
    if ([...url.searchParams.values()].some((value) => value === apiKey)) {
      throw invalidConfiguration(operation);
    }

    const abort = composeAbortSignals(
      request.signal,
      connection.request.timeoutMs,
      scheduleTimeout,
      cancelTimeout,
    );
    try {
      if (abort.signal.aborted) throw callerAbortReason(abort.signal);
      const headers = new Headers(request.headers);
      headers.set("accept", "application/json");
      headers.set("x-api-key", apiKey);
      const finalRequest = new Request(request, {
        headers,
        redirect: "error",
        signal: abort.signal,
      });
      const response = await raceAbort(trustedFetch(finalRequest), abort.signal);
      await raceAbort(delay(connection.request.delayMs), abort.signal);

      if (!response.ok) {
        try {
          await readBoundedBody(response, maxErrorBodyBytes, abort.signal);
        } catch (error: unknown) {
          if (!(error instanceof BodyLimitError)) throw error;
        }
        throw classifyLidarrStatus(
          response.status,
          operation,
          parseRetryAfter(response.headers.get("retry-after")),
        );
      }

      const body = await readBoundedBody(response, maxSuccessBodyBytes, abort.signal);
      validateUtf8(body);
      return reconstructResponse(response, body);
    } catch (error: unknown) {
      throwMappedFailure(error, operation, request.signal, abort);
    } finally {
      abort.cleanup();
    }
  };
}
