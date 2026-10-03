/**
 * The machine failure envelope shared by all four `plex auth` verbs (issue #251).
 *
 * Split out of `plex-auth.ts` because it is a different job: that module
 * orchestrates the verbs, this one projects ONE caught value onto a stable,
 * secret-free contract. It is the counterpart of the success envelopes and the
 * only thing the command layer prints before setting `process.exitCode = 1`.
 *
 * `reportLidarrFailure` is deliberately NOT reused: it is module-private to
 * `commands/lidarr.ts` and hard-codes `lidarr-${subcommand}` plus Lidarr's own
 * lane/attempt execution metadata, none of which exists here.
 *
 * SECRET HYGIENE. `remediation` always comes from a frozen local literal —
 * either `PlexAuthError`'s own table or {@link FALLBACK_REMEDIATIONS} — so no
 * server-supplied text can reach a terminal through it. `message` is the caught
 * error's own text passed through `redactErrorMessage` with the configured
 * legacy Plex token as an explicit sensitive value. `diagnostics` carries
 * response key NAMES only, already bounded and charset-filtered upstream.
 */

import {
  PlexAuthError,
  PlexJwtWireError,
  type PlexAuthErrorCode,
} from "../lib/adapters/plex-adapter.js";
import { MissingRequiredArgumentError } from "../lib/errors.js";
import { getLoadedPlexConfig } from "../lib/loaded-config.js";
import { redactErrorMessage } from "../lib/redact-error-message.js";
import { MediaServerError } from "../types/media-server.js";

/** The four verbs, used to build the `plex-auth-<verb>` envelope discriminator. */
export type PlexAuthVerb = "login" | "status" | "refresh" | "logout";

/**
 * Which failures a caller may usefully retry unchanged.
 *
 * A mapped type over the closed {@link PlexAuthErrorCode} union, so a new code
 * added without an entry here is a compile error rather than a silent `false`.
 */
const PLEX_AUTH_RETRYABLE: Readonly<Record<PlexAuthErrorCode, boolean>> = Object.freeze({
  PLEX_AUTH_NOT_ENROLLED: false,
  PLEX_AUTH_ORIGIN_NOT_AUTHORIZED: false,
  PLEX_AUTH_STORE_UNSAFE_PATH: false,
  PLEX_AUTH_STORE_PERMISSIONS: false,
  PLEX_AUTH_STORE_CORRUPT: false,
  PLEX_AUTH_STORE_VERSION_CONFLICT: true,
  PLEX_AUTH_REFRESH_BUSY: true,
  PLEX_AUTH_RATE_LIMITED: true,
  PLEX_AUTH_ENROLLMENT_EXPIRED: false,
  PLEX_AUTH_KEY_REJECTED: false,
  PLEX_AUTH_UNREACHABLE: true,
  PLEX_AUTH_CANCELLED: true,
  PLEX_AUTH_PMS_REJECTED: false,
  PLEX_AUTH_INVALID_RESPONSE: false,
  PLEX_AUTH_CLOCK_SKEW: false,
});

/** Code for a failure that named a missing option; no `PlexAuthError` exists for it. */
const ARGUMENT_REQUIRED_CODE = "PLEX_AUTH_ARGUMENT_REQUIRED";

/** Code for a failure that rejected an option's value. */
const ARGUMENT_INVALID_CODE = "PLEX_AUTH_ARGUMENT_INVALID";

/** Code for anything this build cannot classify; always a bug worth reporting. */
const UNEXPECTED_CODE = "PLEX_AUTH_UNEXPECTED";

/** Frozen local remediations for the failures that carry none of their own. */
const FALLBACK_REMEDIATIONS = Object.freeze({
  argumentRequired: "Supply the option named in the message, then run the command again.",
  argumentInvalid: "Correct the reported option value, then run the command again.",
  server: "Check the Plex server URL and that the server is reachable, then run again.",
  wire: "Upgrade rfmedia. If the failure persists, report the diagnostics.observedKeys field.",
  unexpected: "Re-run with --debug and report the failure if it persists.",
});

/**
 * Bounded, charset-filtered response key NAMES from an unrecognized 2xx body.
 *
 * Diagnostics only. Rendered in the `--output json` envelope, and in text mode
 * only under `--debug`. Never a value, only a name.
 */
export interface PlexAuthFailureDiagnostics {
  readonly observedKeys: readonly string[];
  /** Absent when the failure was already mapped and no longer carries the flag. */
  readonly observedKeysTruncated?: boolean;
}

/** Machine-readable failure envelope shared by all four verbs. */
export interface PlexAuthFailureEnvelope {
  readonly command: `plex-auth-${PlexAuthVerb}`;
  readonly error: {
    /** Redacted, terminal-safe text. Never a raw wire `message`. */
    readonly message: string;
    readonly code: string;
    readonly retryable: boolean;
    /** Always present; mandatory in practice for `PLEX_AUTH_RATE_LIMITED`. */
    readonly retryAfterSeconds: number | null;
    /** Usually `null`: plex.tv statuses are collapsed into codes by the wire layer. */
    readonly statusCode: number | null;
    readonly remediation: string;
    readonly diagnostics?: PlexAuthFailureDiagnostics;
  };
}

/** Everything {@link buildPlexAuthFailureEnvelope} derives from one caught value. */
interface PlexAuthFailureDetail {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
  readonly statusCode: number | null;
  readonly remediation: string;
  readonly diagnostics?: PlexAuthFailureDiagnostics;
}

/**
 * Classifies one caught value into the fields of a failure envelope.
 *
 * The function is total over `unknown`: an unclassifiable value still yields a
 * complete envelope, because a command that cannot report why it failed is
 * worse than one that reports `PLEX_AUTH_UNEXPECTED`.
 *
 * @param error - The value thrown by a verb.
 * @returns Code, retryability, advisory waits, remediation, and diagnostics.
 */
function classifyPlexAuthFailure(error: unknown): PlexAuthFailureDetail {
  if (error instanceof PlexAuthError) {
    const detail: PlexAuthFailureDetail = {
      code: error.code,
      retryable: PLEX_AUTH_RETRYABLE[error.code],
      retryAfterSeconds: error.retryAfterSeconds ?? null,
      statusCode: null,
      remediation: error.remediation,
    };
    return error.observedKeys === undefined
      ? detail
      : { ...detail, diagnostics: { observedKeys: error.observedKeys } };
  }

  if (error instanceof PlexJwtWireError) {
    return {
      code: error.code,
      retryable: false,
      retryAfterSeconds: null,
      statusCode: null,
      remediation: FALLBACK_REMEDIATIONS.wire,
      diagnostics: {
        observedKeys: error.observedKeys,
        observedKeysTruncated: error.observedKeysTruncated,
      },
    };
  }

  if (error instanceof MediaServerError) {
    return {
      code: error.code,
      retryable: error.retryable,
      retryAfterSeconds: error.retryAfterSeconds ?? null,
      statusCode: error.statusCode ?? null,
      remediation: FALLBACK_REMEDIATIONS.server,
    };
  }

  if (error instanceof MissingRequiredArgumentError) {
    return {
      code: ARGUMENT_REQUIRED_CODE,
      retryable: false,
      retryAfterSeconds: null,
      statusCode: null,
      remediation: FALLBACK_REMEDIATIONS.argumentRequired,
    };
  }

  const invalidArgument = error instanceof TypeError;
  return {
    code: invalidArgument ? ARGUMENT_INVALID_CODE : UNEXPECTED_CODE,
    retryable: false,
    retryAfterSeconds: null,
    statusCode: null,
    remediation: invalidArgument
      ? FALLBACK_REMEDIATIONS.argumentInvalid
      : FALLBACK_REMEDIATIONS.unexpected,
  };
}

/**
 * Builds the machine failure envelope the command layer prints before exiting 1.
 *
 * @param verb - Which `plex auth` verb failed.
 * @param error - The value it threw.
 * @returns The `{ command, error }` envelope, ready for `formatOutput`.
 */
export function buildPlexAuthFailureEnvelope(
  verb: PlexAuthVerb,
  error: unknown,
): PlexAuthFailureEnvelope {
  const detail = classifyPlexAuthFailure(error);
  const envelopeError = {
    message: redactErrorMessage(error, [getLoadedPlexConfig().token]),
    code: detail.code,
    retryable: detail.retryable,
    retryAfterSeconds: detail.retryAfterSeconds,
    statusCode: detail.statusCode,
    remediation: detail.remediation,
  };

  return detail.diagnostics === undefined
    ? { command: `plex-auth-${verb}`, error: envelopeError }
    : {
        command: `plex-auth-${verb}`,
        error: { ...envelopeError, diagnostics: detail.diagnostics },
      };
}
