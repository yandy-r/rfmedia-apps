/**
 * Lidarr error taxonomy.
 *
 * A dedicated `LidarrError` hierarchy carries the semantic distinction the
 * generic `MediaServerErrorCode` union cannot express: a *local Lidarr instance
 * being unreachable* versus *Lidarr's upstream metadata provider
 * (`api.lidarr.audio`) being unavailable*. The base class mirrors the field
 * shape of `MediaServerError` (`code`, `operation`, `statusCode`, `retryable`)
 * for interop with the wider error surface, while remaining a distinct type so
 * Lidarr is never implied to satisfy the `MediaServerAdapter` contract.
 *
 * `classifyLidarrStatus` maps an HTTP failure into this taxonomy and is the
 * single mapper the client uses. `parseRetryAfter` extracts the delta-seconds
 * form of a `Retry-After` header so `RateLimitedError` can surface it for the
 * resilience layer (#195) to honor; it now lives in `../retry-after.js` because
 * the Plex account path (#251) needs the same parser, and is re-exported here
 * unchanged for every existing importer.
 */

/**
 * Wire-level classification code.
 *
 * Field-shape compatible with `MediaServerErrorCode` but extended with the two
 * Lidarr-specific reachability codes (`lidarr-unreachable`,
 * `metadata-provider-unavailable`) that the generic union cannot carry.
 */
export type LidarrErrorCode =
  | "lidarr-unreachable"
  | "metadata-provider-unavailable"
  | "rate-limited"
  | "validation"
  | "authentication"
  | "authorization"
  | "not-found"
  | "invalid-response"
  | "timeout"
  | "configuration";

/** Structured context used to construct a {@link LidarrError}. */
export interface LidarrErrorContext {
  /** Human-readable label for the failing operation, used in error context. */
  readonly operation: string;
  /** HTTP status code, when the failure originated from a response. */
  readonly statusCode?: number;
  /** Whether the failure is safe to retry. */
  readonly retryable?: boolean;
  /** Seconds to wait before retrying; parsed from `Retry-After` when present. */
  readonly retryAfterSeconds?: number;
  /** Underlying cause, attached to the native `Error` cause chain. */
  readonly cause?: unknown;
}

/**
 * Base class for all Lidarr failures.
 *
 * Every Lidarr error crosses the client boundary as a `LidarrError` subclass.
 * Messages must be scrubbed of credentials and raw bodies before construction.
 */
export abstract class LidarrError extends Error {
  /** Stable wire-level classification code. */
  abstract readonly code: LidarrErrorCode;
  /** Human-readable label for the failing operation. */
  readonly operation: string;
  /** HTTP status code, when the failure originated from a response. */
  readonly statusCode?: number;
  /** Whether the failure is safe to retry. */
  readonly retryable: boolean;
  /** Seconds to wait before retrying, when the server supplied `Retry-After`. */
  readonly retryAfterSeconds?: number;

  /**
   * @param message - Sanitized, human-readable failure description.
   * @param ctx - Structured error context.
   */
  protected constructor(message: string, ctx: LidarrErrorContext) {
    super(message, ctx.cause === undefined ? undefined : { cause: ctx.cause });
    this.name = new.target.name;
    this.operation = ctx.operation;
    this.statusCode = ctx.statusCode;
    this.retryable = ctx.retryable ?? false;
    this.retryAfterSeconds = ctx.retryAfterSeconds;
  }
}

const lidarrHttpStatuses = new WeakMap<LidarrError, number>();

/**
 * Tests internal HTTP-response metadata without exposing it through the public
 * error shape.
 *
 * @param error - Candidate Lidarr failure.
 * @param status - HTTP status to match.
 * @returns Whether the failure originated from the requested HTTP status.
 * @internal
 */
export function hasLidarrHttpStatus(error: unknown, status: number): error is LidarrError {
  return error instanceof LidarrError && lidarrHttpStatuses.get(error) === status;
}

/**
 * The local Lidarr instance/API is unreachable or returned a 5xx.
 *
 * A hard failure that affects every reliability tier. Retryable.
 */
export class LidarrUnreachableError extends LidarrError {
  readonly code = "lidarr-unreachable" as const;

  /**
   * @param operation - Human-readable label for the failing operation.
   * @param message - Sanitized failure description.
   * @param ctx - Additional error context (status code, cause).
   */
  constructor(
    operation: string,
    message = "Lidarr is unreachable",
    ctx: Partial<LidarrErrorContext> = {},
  ) {
    super(message, { operation, retryable: true, ...ctx });
  }
}

/**
 * A request that exceeded its timeout budget (the `AbortController` deadline
 * fired before the response completed).
 *
 * Distinguished from {@link LidarrUnreachableError} so downstream consumers
 * (e.g. the #195 resilience layer) can apply timeout-specific backoff without
 * conflating a slow instance with an unreachable one. Retryable.
 */
export class LidarrTimeoutError extends LidarrError {
  readonly code = "timeout" as const;

  /**
   * @param operation - Human-readable label for the failing operation.
   * @param message - Sanitized failure description.
   * @param ctx - Additional error context (cause).
   */
  constructor(
    operation: string,
    message = "Lidarr request timed out",
    ctx: Partial<LidarrErrorContext> = {},
  ) {
    super(message, { operation, retryable: true, ...ctx });
  }
}

/**
 * The upstream metadata provider (`api.lidarr.audio`) is unavailable while the
 * local Lidarr instance is up.
 *
 * Only affects Tier-3 (metadata-dependent) operations; for the baseline reads
 * this case is unreachable. Expected, not exceptional. Retryable.
 */
export class MetadataProviderUnavailableError extends LidarrError {
  readonly code = "metadata-provider-unavailable" as const;

  /**
   * @param operation - Human-readable label for the failing operation.
   * @param message - Sanitized failure description.
   * @param ctx - Additional error context (status code, cause).
   */
  constructor(
    operation: string,
    message = "Lidarr metadata server is unavailable",
    ctx: Partial<LidarrErrorContext> = {},
  ) {
    super(message, { operation, retryable: true, ...ctx });
  }
}

/**
 * A 429 (or documented 503 overload) response. Carries `Retry-After` when the
 * server supplied it. Retryable.
 */
export class RateLimitedError extends LidarrError {
  readonly code = "rate-limited" as const;

  /**
   * @param operation - Human-readable label for the failing operation.
   * @param retryAfterSeconds - Seconds to wait, parsed from `Retry-After`.
   * @param ctx - Additional error context (status code, cause).
   */
  constructor(
    operation: string,
    retryAfterSeconds?: number,
    ctx: Partial<LidarrErrorContext> = {},
  ) {
    super(
      retryAfterSeconds !== undefined
        ? `Lidarr rate-limited (retry after ${retryAfterSeconds}s)`
        : "Lidarr rate-limited",
      { operation, retryable: true, retryAfterSeconds, ...ctx },
    );
  }
}

/**
 * A client-side request-shape / input validation failure, a malformed-response
 * failure, or an unsafe-configuration failure surfaced before mutation.
 *
 * Never retryable. The concrete `code` distinguishes the three sub-cases.
 */
export class LidarrValidationError extends LidarrError {
  readonly code: LidarrErrorCode;

  /**
   * @param operation - Human-readable label for the failing operation.
   * @param message - Sanitized failure description.
   * @param code - Which validation sub-case this represents.
   */
  constructor(
    operation: string,
    message: string,
    code: "validation" | "invalid-response" | "configuration" = "validation",
  ) {
    super(message, { operation, retryable: false });
    this.code = code;
  }
}

/**
 * An authoritative Lidarr response indicating that the requested resource
 * does not exist.
 *
 * Never retryable. Callers must still decide whether absence satisfies their
 * operation-specific contract.
 */
export class LidarrNotFoundError extends LidarrError {
  readonly code = "not-found" as const;

  /**
   * @param operation - Human-readable label for the failing operation.
   * @param message - Sanitized failure description.
   * @param ctx - Additional error context.
   */
  constructor(
    operation: string,
    message = "Lidarr resource not found",
    ctx: Partial<LidarrErrorContext> = {},
  ) {
    super(message, { operation, statusCode: 404, retryable: false, ...ctx });
  }
}

/**
 * Re-exported from `../retry-after.js`, which is the single implementation
 * shared with the Plex account path. Kept on this module's surface so existing
 * importers (`lidarr/client.ts`, `lidarr/transport.ts`, the `lidarr` barrel)
 * are unaffected by the move.
 */
export { parseRetryAfter } from "../retry-after.js";

/**
 * Map an HTTP failure from a Lidarr request into the error taxonomy.
 *
 * 5xx from the local Lidarr instance means the instance itself is faulted
 * (`LidarrUnreachableError`), except a 503 with `Retry-After`, which is an
 * explicit overload signal (`RateLimitedError`). The distinct
 * metadata-provider-unavailable case is only surfaced by Tier-3 endpoints and
 * is not reachable via the four baseline reads.
 *
 * @param status - HTTP status code from the response.
 * @param operation - Human-readable label for the failing operation.
 * @param retryAfterSeconds - Parsed `Retry-After`, forwarded to rate-limit errors.
 * @returns The typed {@link LidarrError} for the given status.
 */
export function classifyLidarrStatus(
  status: number,
  operation: string,
  retryAfterSeconds?: number,
): LidarrError {
  switch (status) {
    case 401:
      return new LidarrValidationError(
        operation,
        "Lidarr authentication failed (HTTP 401)",
        "configuration",
      );
    case 403:
      return new LidarrValidationError(
        operation,
        "Lidarr authorization failed (HTTP 403)",
        "configuration",
      );
    case 404: {
      const notFoundError = new LidarrValidationError(
        operation,
        "Lidarr resource not found (HTTP 404)",
        "validation",
      );
      lidarrHttpStatuses.set(notFoundError, status);
      return notFoundError;
    }
    case 429:
      return new RateLimitedError(operation, retryAfterSeconds, { statusCode: 429 });
    case 503:
      if (retryAfterSeconds !== undefined) {
        return new RateLimitedError(operation, retryAfterSeconds, { statusCode: 503 });
      }
      return new LidarrUnreachableError(operation, "Lidarr returned HTTP 503", {
        statusCode: 503,
      });
    default:
      if (status >= 500) {
        return new LidarrUnreachableError(operation, `Lidarr returned HTTP ${status}`, {
          statusCode: status,
        });
      }
      return new LidarrValidationError(
        operation,
        `Unexpected Lidarr response (HTTP ${status})`,
        "validation",
      );
  }
}
