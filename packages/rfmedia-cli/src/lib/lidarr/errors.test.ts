import { describe, expect, it } from "vitest";

import {
  LidarrError,
  LidarrNotFoundError,
  LidarrTimeoutError,
  LidarrUnreachableError,
  LidarrValidationError,
  MetadataProviderUnavailableError,
  RateLimitedError,
  classifyLidarrStatus,
  hasLidarrHttpStatus,
  parseRetryAfter,
  type LidarrErrorCode,
} from "./errors.js";

describe("classifyLidarrStatus", () => {
  it.each([
    [401, LidarrValidationError, "configuration"],
    [403, LidarrValidationError, "configuration"],
    [404, LidarrValidationError, "validation"],
    [429, RateLimitedError, "rate-limited"],
    [500, LidarrUnreachableError, "lidarr-unreachable"],
    [503, LidarrUnreachableError, "lidarr-unreachable"],
    [418, LidarrValidationError, "validation"],
  ])("maps HTTP %i to the expected error class", (status, ctor, code) => {
    const error = classifyLidarrStatus(status, "test-op");
    expect(error).toBeInstanceOf(ctor);
    expect(error).toBeInstanceOf(LidarrError);
    expect(error.code).toBe(code as LidarrErrorCode);
    expect(error.operation).toBe("test-op");
  });

  it("marks 5xx failures retryable and carries the status code", () => {
    const error = classifyLidarrStatus(502, "system-status");
    expect(error).toBeInstanceOf(LidarrUnreachableError);
    expect(error.retryable).toBe(true);
    expect(error.statusCode).toBe(502);
    expect(error.message).toContain("HTTP 502");
  });

  it("keeps non-targeted 404 failures classified as non-retryable validation", () => {
    const error = classifyLidarrStatus(404, "list-artists");
    expect(error).toBeInstanceOf(LidarrValidationError);
    expect(error.code).toBe("validation");
    expect(error.retryable).toBe(false);
    expect(error.statusCode).toBeUndefined();
  });

  it("preserves internal HTTP 404 metadata independently of message wording", () => {
    const error = classifyLidarrStatus(404, "get-artist");
    error.message = "updated wording";

    expect(hasLidarrHttpStatus(error, 404)).toBe(true);
    expect(hasLidarrHttpStatus(error, 418)).toBe(false);
    expect(hasLidarrHttpStatus(classifyLidarrStatus(418, "get-artist"), 404)).toBe(false);
  });

  it("forwards parsed Retry-After onto rate-limit errors", () => {
    const error = classifyLidarrStatus(429, "wanted", 12);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error.retryAfterSeconds).toBe(12);
    expect(error.statusCode).toBe(429);
    expect(error.retryable).toBe(true);
  });

  it("treats a 503 with Retry-After as an overload signal", () => {
    const error = classifyLidarrStatus(503, "wanted", 9);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error.code).toBe("rate-limited");
    expect(error.retryAfterSeconds).toBe(9);
    expect(error.statusCode).toBe(503);
  });
});

describe("parseRetryAfter", () => {
  it.each([
    ["30", 30],
    ["0", 0],
    ["  45 ", 45],
  ])("parses delta-seconds %j as %i", (header, expected) => {
    expect(parseRetryAfter(header)).toBe(expected);
  });

  it("returns undefined when the header is absent", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it("returns undefined for the HTTP-date form", () => {
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT")).toBeUndefined();
  });

  it("returns undefined for negative or non-numeric values", () => {
    expect(parseRetryAfter("-5")).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});

describe("LidarrUnreachableError", () => {
  it("carries the unreachable code and default retryable state", () => {
    const error = new LidarrUnreachableError("system-status");
    expect(error).toBeInstanceOf(LidarrError);
    expect(error.name).toBe("LidarrUnreachableError");
    expect(error.code).toBe("lidarr-unreachable");
    expect(error.operation).toBe("system-status");
    expect(error.retryable).toBe(true);
    expect(error.message).toBe("Lidarr is unreachable");
    expect(error.statusCode).toBeUndefined();
    expect(error.retryAfterSeconds).toBeUndefined();
  });

  it("accepts an overridden message, status code, and cause", () => {
    const cause = new Error("ECONNREFUSED");
    const error = new LidarrUnreachableError("system-status", "Lidarr returned HTTP 500", {
      statusCode: 500,
      cause,
    });
    expect(error.message).toBe("Lidarr returned HTTP 500");
    expect(error.statusCode).toBe(500);
    expect(error.cause).toBe(cause);
  });
});

describe("LidarrTimeoutError", () => {
  it("carries the timeout code and is retryable", () => {
    const error = new LidarrTimeoutError("system-status");
    expect(error).toBeInstanceOf(LidarrError);
    expect(error.name).toBe("LidarrTimeoutError");
    expect(error.code).toBe("timeout");
    expect(error.operation).toBe("system-status");
    expect(error.retryable).toBe(true);
    expect(error.message).toBe("Lidarr request timed out");
    expect(error.statusCode).toBeUndefined();
  });
});

describe("MetadataProviderUnavailableError", () => {
  it("carries the metadata-provider code and is retryable", () => {
    const error = new MetadataProviderUnavailableError("artist-lookup");
    expect(error).toBeInstanceOf(LidarrError);
    expect(error.name).toBe("MetadataProviderUnavailableError");
    expect(error.code).toBe("metadata-provider-unavailable");
    expect(error.operation).toBe("artist-lookup");
    expect(error.retryable).toBe(true);
    expect(error.message).toBe("Lidarr metadata server is unavailable");
  });
});

describe("RateLimitedError", () => {
  it("includes the retry-after in the message when supplied", () => {
    const error = new RateLimitedError("wanted", 30, { statusCode: 429 });
    expect(error).toBeInstanceOf(LidarrError);
    expect(error.name).toBe("RateLimitedError");
    expect(error.code).toBe("rate-limited");
    expect(error.operation).toBe("wanted");
    expect(error.retryable).toBe(true);
    expect(error.retryAfterSeconds).toBe(30);
    expect(error.statusCode).toBe(429);
    expect(error.message).toBe("Lidarr rate-limited (retry after 30s)");
  });

  it("omits the retry-after from the message when absent", () => {
    const error = new RateLimitedError("wanted");
    expect(error.retryAfterSeconds).toBeUndefined();
    expect(error.message).toBe("Lidarr rate-limited");
  });
});

describe("LidarrValidationError", () => {
  it("defaults to the validation code and is never retryable", () => {
    const error = new LidarrValidationError("list-artists", "bad request shape");
    expect(error).toBeInstanceOf(LidarrError);
    expect(error.name).toBe("LidarrValidationError");
    expect(error.code).toBe("validation");
    expect(error.operation).toBe("list-artists");
    expect(error.retryable).toBe(false);
    expect(error.message).toBe("bad request shape");
    expect(error.statusCode).toBeUndefined();
    expect(error.retryAfterSeconds).toBeUndefined();
  });

  it.each([["validation" as const], ["invalid-response" as const], ["configuration" as const]])(
    "carries the %s sub-case code",
    (code) => {
      const error = new LidarrValidationError("op", "message", code);
      expect(error.code).toBe(code);
      expect(error.retryable).toBe(false);
    },
  );
});

describe("LidarrNotFoundError", () => {
  it("carries the typed absence code and is never retryable", () => {
    const error = new LidarrNotFoundError("get-artist");
    expect(error).toBeInstanceOf(LidarrError);
    expect(error.name).toBe("LidarrNotFoundError");
    expect(error.code).toBe("not-found");
    expect(error.operation).toBe("get-artist");
    expect(error.retryable).toBe(false);
    expect(error.statusCode).toBe(404);
    expect(error.message).toBe("Lidarr resource not found");
  });
});
