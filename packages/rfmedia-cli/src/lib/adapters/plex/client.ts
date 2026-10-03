import { MediaServerError, type MediaServerErrorCode } from "../../../types/media-server.js";
import { parseRetryAfter } from "../../retry-after.js";
import type { PlexTokenProvider } from "./auth.js";
import {
  BodyLimitError,
  callerAbortReason,
  composeAbortSignals,
  isAborted,
  readBoundedBody,
  sanitizeMessage,
  type AbortComposition,
} from "./http.js";
import type {
  PlexConnectionSettings,
  PlexHttpMethod,
  PlexRequestInput,
  PlexRequestOptions,
} from "./types.js";

const DEFAULT_SUCCESS_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_ERROR_BODY_BYTES = 4 * 1024;
const SENSITIVE_QUERY_KEY_PATTERN = /(?:authorization|jwt|nonce|privatekey|token)/iu;

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Test seams and hard response limits for one private Plex client. */
export interface PlexClientDependencies {
  readonly fetch?: FetchImplementation;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly scheduleTimeout?: (callback: () => void, milliseconds: number) => unknown;
  readonly cancelTimeout?: (handle: unknown) => void;
  readonly maxSuccessBodyBytes?: number;
  readonly maxErrorBodyBytes?: number;
}

/** The sole authenticated request primitive consumed by private Plex endpoint modules. */
export interface PlexTransport {
  request<T>(input: PlexRequestInput): Promise<T>;
}

interface PlexRequestAttempt {
  readonly input: PlexRequestInput;
  readonly method: PlexHttpMethod;
  /**
   * Whether this request may be sent a second time after credential recovery.
   *
   * Also gates the advisory `retryable` flag on every thrown error, so an
   * unreplayable request is never advertised as retryable to an outer layer.
   */
  readonly replayable: boolean;
  readonly callerSignal: AbortSignal | undefined;
  readonly token: string;
  readonly url: URL;
  readonly allowAuthRetry: boolean;
}

type PlexRequestAttemptResult<T> =
  | { readonly kind: "success"; readonly value: T }
  | { readonly kind: "retry" };

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function defaultScheduleTimeout(callback: () => void, milliseconds: number): unknown {
  return setTimeout(callback, milliseconds);
}

function defaultCancelTimeout(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function mediaServerError(
  operation: string,
  code: MediaServerErrorCode,
  message: string,
  options: {
    readonly statusCode?: number;
    readonly retryable?: boolean;
    readonly retryAfterSeconds?: number;
  } = {},
): MediaServerError {
  return new MediaServerError(message, {
    code,
    serverType: "plex",
    operation,
    statusCode: options.statusCode,
    retryable: options.retryable ?? false,
    retryAfterSeconds: options.retryAfterSeconds,
  });
}

function configurationError(operation: string, error: unknown, token?: string): MediaServerError {
  const detail = sanitizeMessage(error, token === undefined ? [] : [token]);
  return mediaServerError(
    operation,
    "configuration",
    detail.length > 0
      ? `Invalid Plex request configuration: ${detail}`
      : "Invalid Plex request configuration",
  );
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

function buildRequestUrl(
  connection: PlexConnectionSettings,
  path: string,
  query: PlexRequestOptions["query"],
  token: string,
): URL {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#")
  ) {
    throw new TypeError(
      "Plex request path must be an absolute-path relative URL without a query or fragment",
    );
  }

  const url = new URL(path, `${connection.origin}/`);
  if (url.origin !== connection.origin) {
    throw new TypeError("Plex request path resolved outside the configured origin");
  }

  for (const [key, value] of Object.entries(query ?? {})) {
    if (SENSITIVE_QUERY_KEY_PATTERN.test(key)) {
      throw new TypeError("Plex request query must not contain authentication material");
    }
    if (value !== undefined) {
      const serializedValue = String(value);
      if (serializedValue === token) {
        throw new TypeError("Plex request query must not contain authentication material");
      }
      url.searchParams.append(key, serializedValue);
    }
  }
  return url;
}

function parseJsonBody<T>(body: Uint8Array): T {
  if (body.byteLength === 0) {
    return undefined as T;
  }

  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  return JSON.parse(text) as T;
}

function statusClassification(status: number): {
  readonly code: MediaServerErrorCode;
  readonly description: string;
  readonly retryable: boolean;
} {
  switch (status) {
    case 401:
      return {
        code: "authentication",
        description: "Plex authentication failed",
        retryable: false,
      };
    case 403:
      return { code: "authorization", description: "Plex authorization failed", retryable: false };
    case 404:
      return { code: "not-found", description: "Plex resource was not found", retryable: false };
    case 422:
      return {
        code: "authentication",
        description: "Plex credential signature was rejected",
        retryable: false,
      };
    case 429:
      return {
        code: "rate-limited",
        description: "Plex request was rate limited",
        retryable: true,
      };
    case 498:
      return { code: "authentication", description: "Plex JWT has expired", retryable: false };
    default:
      return {
        code: "request-failed",
        description:
          status >= 300 && status < 400 ? "Plex redirect was rejected" : "Plex request failed",
        retryable: status >= 500,
      };
  }
}

function isAuthenticationStatus(status: number): boolean {
  return status === 401 || status === 422 || status === 498;
}

/**
 * Origin-bound Plex HTTP client with header-only authentication and bounded responses.
 */
export class PlexClient implements PlexTransport {
  readonly #connection: PlexConnectionSettings;
  readonly #tokenProvider: PlexTokenProvider;
  readonly #fetch: FetchImplementation;
  readonly #delay: (milliseconds: number) => Promise<void>;
  readonly #scheduleTimeout: (callback: () => void, milliseconds: number) => unknown;
  readonly #cancelTimeout: (handle: unknown) => void;
  readonly #maxSuccessBodyBytes: number;
  readonly #maxErrorBodyBytes: number;

  constructor(
    connection: PlexConnectionSettings,
    tokenProvider: PlexTokenProvider,
    dependencies: PlexClientDependencies = {},
  ) {
    this.#connection = connection;
    this.#tokenProvider = tokenProvider;
    this.#fetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    this.#delay = dependencies.delay ?? defaultDelay;
    this.#scheduleTimeout = dependencies.scheduleTimeout ?? defaultScheduleTimeout;
    this.#cancelTimeout = dependencies.cancelTimeout ?? defaultCancelTimeout;
    this.#maxSuccessBodyBytes = validatePositiveLimit(
      "maxSuccessBodyBytes",
      dependencies.maxSuccessBodyBytes ?? DEFAULT_SUCCESS_BODY_BYTES,
    );
    this.#maxErrorBodyBytes = validatePositiveLimit(
      "maxErrorBodyBytes",
      dependencies.maxErrorBodyBytes ?? DEFAULT_ERROR_BODY_BYTES,
    );
    validatePositiveLimit("timeoutMs", connection.request.timeoutMs);
    validateNonNegativeLimit("delayMs", connection.request.delayMs);
    Object.freeze(this);
  }

  async request<T>(input: PlexRequestInput): Promise<T> {
    const method = input.options?.method ?? "GET";
    const replayable = input.replayable ?? method === "GET";
    const callerSignal = input.options?.signal;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (isAborted(callerSignal)) {
        throw callerAbortReason(callerSignal);
      }

      const token = await this.#getToken(input.operation, callerSignal);
      const url = this.#createRequestUrl(input, token);
      const result = await this.#executeAttempt<T>({
        input,
        method,
        replayable,
        callerSignal,
        token,
        url,
        allowAuthRetry: attempt === 0,
      });
      if (result.kind === "success") {
        return result.value;
      }
    }

    throw new Error("Plex authentication retry limit was exceeded");
  }

  async #getToken(operation: string, signal: AbortSignal | undefined): Promise<string> {
    try {
      return await this.#tokenProvider.getToken({ signal });
    } catch (error: unknown) {
      if (error instanceof MediaServerError) {
        throw error;
      }
      throw mediaServerError(
        operation,
        "configuration",
        "Plex credential is unavailable or invalid",
      );
    }
  }

  #createRequestUrl(input: PlexRequestInput, token: string): URL {
    try {
      return buildRequestUrl(this.#connection, input.path, input.options?.query, token);
    } catch (error: unknown) {
      throw configurationError(input.operation, error, token);
    }
  }

  async #executeAttempt<T>(attempt: PlexRequestAttempt): Promise<PlexRequestAttemptResult<T>> {
    const abort = composeAbortSignals(
      attempt.callerSignal,
      this.#connection.request.timeoutMs,
      this.#scheduleTimeout,
      this.#cancelTimeout,
    );

    try {
      const response = await this.#fetch(attempt.url, {
        method: attempt.method,
        headers: { Accept: "application/json", "X-Plex-Token": attempt.token },
        redirect: "error",
        signal: abort.signal,
      });
      await this.#delay(this.#connection.request.delayMs);

      if (!response.ok) {
        return await this.#handleNonSuccess(response, attempt);
      }
      return {
        kind: "success",
        value: await this.#parseSuccessBody<T>(response, attempt, abort),
      };
    } catch (error: unknown) {
      this.#throwAttemptError(error, attempt, abort);
    } finally {
      abort.cleanup();
    }
  }

  async #handleNonSuccess(
    response: Response,
    attempt: PlexRequestAttempt,
  ): Promise<{ readonly kind: "retry" }> {
    try {
      await readBoundedBody(response, this.#maxErrorBodyBytes);
    } catch (error: unknown) {
      if (!(error instanceof BodyLimitError)) {
        throw error;
      }
    }

    if (
      attempt.replayable &&
      attempt.allowAuthRetry &&
      isAuthenticationStatus(response.status) &&
      (await this.#tokenProvider.handleAuthFailure?.(response.status, {
        signal: attempt.callerSignal,
      })) === "retry"
    ) {
      return { kind: "retry" };
    }

    const classified = statusClassification(response.status);
    throw mediaServerError(
      attempt.input.operation,
      classified.code,
      `${classified.description} (HTTP ${response.status})`,
      {
        statusCode: response.status,
        retryable: classified.retryable && attempt.replayable,
        retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
      },
    );
  }

  async #parseSuccessBody<T>(
    response: Response,
    attempt: PlexRequestAttempt,
    abort: AbortComposition,
  ): Promise<T> {
    try {
      const body = await readBoundedBody(response, this.#maxSuccessBodyBytes);
      return parseJsonBody<T>(body);
    } catch (error: unknown) {
      if (abort.didTimeout()) {
        throw mediaServerError(attempt.input.operation, "timeout", "Plex request timed out", {
          retryable: attempt.replayable,
        });
      }
      if (isAborted(attempt.callerSignal)) {
        throw callerAbortReason(attempt.callerSignal);
      }
      throw mediaServerError(
        attempt.input.operation,
        "invalid-response",
        error instanceof BodyLimitError
          ? "Plex response exceeded the allowed size"
          : "Plex returned an invalid JSON response",
      );
    }
  }

  #throwAttemptError(error: unknown, attempt: PlexRequestAttempt, abort: AbortComposition): never {
    if (error instanceof MediaServerError) {
      throw error;
    }
    if (isAborted(attempt.callerSignal)) {
      throw callerAbortReason(attempt.callerSignal);
    }
    if (abort.didTimeout()) {
      throw mediaServerError(attempt.input.operation, "timeout", "Plex request timed out", {
        retryable: attempt.replayable,
      });
    }

    const detail = sanitizeMessage(error, [attempt.token]);
    if (error instanceof TypeError || error instanceof DOMException) {
      throw mediaServerError(
        attempt.input.operation,
        "network",
        detail.length > 0
          ? `Plex network request failed: ${detail}`
          : "Plex network request failed",
        { retryable: attempt.replayable },
      );
    }
    throw mediaServerError(
      attempt.input.operation,
      "request-failed",
      detail.length > 0 ? `Plex request failed: ${detail}` : "Plex request failed",
      { retryable: false },
    );
  }
}
