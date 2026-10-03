import type { PlexAuthConfigOptions, PlexConfigOptions } from "../../types/config.js";
import type { MediaServerAdapter, MediaServerType } from "../../types/media-server.js";
import { getLoadedConfig, getLoadedPlexConfig } from "../loaded-config.js";
import { logWarn } from "../logger.js";
import { normalizePlexOrigin } from "../plex-origin.js";
import {
  PLEX_AUTH_DEFAULT_REFRESH_MARGIN_SECONDS,
  PlexAdapter,
  PlexAuthError,
  loadPlexAuthStoreSync,
  plexAuthStoreExistsSync,
  readStoredCredential,
} from "./plex-adapter.js";
import type {
  PlexAdapterConfiguration,
  PlexAdapterCredential,
  PlexAuthStoreDependencies,
} from "./plex-adapter.js";

/*
 * IMPORT SURFACE (issue #251). Every Plex symbol above comes from
 * `./plex-adapter.js`, the sole `PRIVATE_PLEX_COMPOSER`. A `./plex/*` specifier
 * here — including an `import type`, which the raw-text architecture gate does
 * not exempt — raises `private-plex-import` and fails both `typecheck` and
 * `build`. A symbol that is missing is added to the façade, never imported
 * around it. `normalizePlexOrigin` lives in `../plex-origin.js` because the
 * enrollment verbs need the same authority; it is never re-implemented here.
 */

/** Whether adapter creation may answer `undefined` or must produce an adapter. */
export type MediaServerAdapterMode = "optional" | "required";

/** CLI override fields used to resolve adapter connection settings. */
export interface MediaServerAdapterOverrides {
  readonly server?: MediaServerType;
  readonly plexUrl?: string;
  readonly plexToken?: string;
  readonly plexLibrary?: string;
  readonly plexScan?: boolean;
  readonly plexPerSource?: boolean;
}

/** Factory options for adapter creation. */
export interface CreateMediaServerAdapterOptions extends MediaServerAdapterOverrides {
  readonly mode?: MediaServerAdapterMode;
}

const DEFAULT_MEDIA_SERVER_TYPE: MediaServerType = "plex";
const MISSING_PLEX_CONNECTION_MESSAGE =
  "Plex URL and token are required. Set in config or use --plex-url and --plex-token";
const MISSING_PLEX_ORIGIN_MESSAGE = "Plex URL is required. Set in config or use --plex-url";
const INVALID_PLEX_URL_MESSAGE = "Invalid Plex URL format";
const CROSS_ORIGIN_OVERRIDE_MESSAGE =
  "A Plex URL override that changes origin requires an explicit --plex-token";
const OPTIONAL_SCAN_WARNING =
  "Plex scan was requested but URL or token is missing or invalid; scan skipped.";
const AMBIGUOUS_PLEX_CREDENTIAL_MESSAGE =
  'plex.auth.mode is "jwt" but plex.token is also set. Remove plex.token, or set plex.auth.mode: static';

type PlexConnectionResolution =
  | { readonly ok: true; readonly configuration: PlexAdapterConfiguration }
  | {
      readonly ok: false;
      readonly reason:
        | "missing"
        | "invalid-url"
        | "cross-origin-override"
        | "ambiguous-credential"
        | "not-enrolled";
    };

/** One credential source chosen by the precedence resolver, already resolved. */
type PlexCredentialSelection =
  | {
      readonly ok: true;
      readonly credential: PlexAdapterCredential;
      /** UUIDv4 minted at enrollment; absent for every static branch. */
      readonly clientIdentifier?: string;
    }
  | {
      readonly ok: false;
      readonly reason: "missing" | "ambiguous-credential" | "not-enrolled";
    };

function resolveMediaServerType(overrides?: MediaServerAdapterOverrides): MediaServerType {
  return overrides?.server ?? DEFAULT_MEDIA_SERVER_TYPE;
}

function resolveStoreDependencies(
  auth: PlexAuthConfigOptions | undefined,
): PlexAuthStoreDependencies {
  return {
    storePath: auth?.storePath,
    refreshMarginSeconds: auth?.refreshMarginSeconds ?? PLEX_AUTH_DEFAULT_REFRESH_MARGIN_SECONDS,
  };
}

/**
 * Resolves a canonical Plex origin without requiring or exposing credentials.
 *
 * An explicit URL is self-contained and does not load configured credentials.
 */
export function resolveRequiredPlexOriginWithoutCredentials(
  overrides: Pick<MediaServerAdapterOverrides, "plexUrl"> = {},
): string {
  const rawUrl = overrides.plexUrl ?? getLoadedPlexConfig().url;
  if (!rawUrl) {
    throw new Error(MISSING_PLEX_ORIGIN_MESSAGE);
  }

  const origin = normalizePlexOrigin(rawUrl);
  if (origin === undefined) {
    throw new Error(INVALID_PLEX_URL_MESSAGE);
  }
  return origin;
}

/**
 * Resolves the enrolled credential for exactly one origin.
 *
 * The credential is read to a `string` HERE rather than inside `PlexAdapter`,
 * because reading it can throw and `createOptionalMediaServerAdapter` must
 * answer `undefined` instead of throwing. The `authorizedOrigins` allowlist is
 * consulted first so an unenrolled origin becomes the typed `not-enrolled`
 * reason instead of an exception used as control flow; `readStoredCredential`
 * still enforces the same allowlist as the authoritative check.
 */
function resolveEnrolledCredential(
  storeDependencies: PlexAuthStoreDependencies,
  origin: string,
  refreshMarginSeconds: number,
): PlexCredentialSelection | undefined {
  const handle = loadPlexAuthStoreSync(storeDependencies);
  if (handle === undefined) return undefined;
  if (!handle.authorizedOrigins.some((entry) => entry.origin === origin)) return undefined;
  return {
    ok: true,
    credential: {
      kind: "enrolled",
      token: readStoredCredential(handle, origin),
      storePath: handle.path,
      refreshMarginSeconds,
    },
    clientIdentifier: handle.clientIdentifier,
  };
}

/**
 * Applies the five-branch credential precedence for one already-guarded origin.
 *
 * 1. `--plex-token` wins unconditionally: it is the only escape hatch that
 *    unlocks a cross-origin `--plex-url`, so demoting it would make that guard
 *    unusable. It also settles a config-level `jwt`/`plex.token` conflict.
 * 2. `plex.auth.mode: "jwt"` uses the enrolled credential for this origin and
 *    **never falls back** — a "try JWT, on 401 try static" chain is a
 *    credential-downgrade oracle that replays under a second identity.
 * 3. `plex.token` outranks the store: ranking a stored credential above a
 *    deliberately-set token is a silent credential swap.
 * 4. The enrolled credential is used opportunistically only when neither 1 nor 3
 *    exists. It is origin-keyed, so it can never be picked up for an
 *    unauthorized origin. `mode: "static"` and an absent `auth` block behave
 *    identically here; opting out of the store means removing it, not renaming
 *    a mode.
 * 5. Otherwise the connection is reported `missing`.
 *
 * A `mode: "jwt"` config that also sets `plex.token` is reported as
 * `ambiguous-credential` rather than resolved, and deliberately not as a
 * `ConfigError`: `loadConfig` warns and falls through to the next search path on
 * a `ConfigError`, which could silently select different credentials.
 */
function selectPlexCredential(
  loadedConfig: PlexConfigOptions,
  storeDependencies: PlexAuthStoreDependencies,
  origin: string,
  overrides: MediaServerAdapterOverrides | undefined,
): PlexCredentialSelection {
  const cliToken = overrides?.plexToken;
  if (cliToken) {
    return { ok: true, credential: { kind: "static", token: cliToken } };
  }

  const refreshMarginSeconds =
    storeDependencies.refreshMarginSeconds ?? PLEX_AUTH_DEFAULT_REFRESH_MARGIN_SECONDS;

  if (loadedConfig.auth?.mode === "jwt") {
    if (loadedConfig.token) {
      return { ok: false, reason: "ambiguous-credential" };
    }
    return (
      resolveEnrolledCredential(storeDependencies, origin, refreshMarginSeconds) ?? {
        ok: false,
        reason: "not-enrolled",
      }
    );
  }

  if (loadedConfig.token) {
    return { ok: true, credential: { kind: "static", token: loadedConfig.token } };
  }

  return (
    resolveEnrolledCredential(storeDependencies, origin, refreshMarginSeconds) ?? {
      ok: false,
      reason: "missing",
    }
  );
}

/**
 * Resolves one adapter configuration from config plus CLI overrides.
 *
 * Order is load-bearing: presence gate, origin normalization, cross-origin
 * guard, and only then credential selection. The guard therefore fires
 * identically whether the credential would have come from config or from the
 * enrolled store — a stored credential does not unlock an origin change.
 *
 * @throws {PlexAuthError} When a store file exists but cannot be trusted
 *   (unsafe path, foreign-readable permissions, or a corrupt document).
 */
function buildPlexAdapterConfiguration(
  loadedConfig: PlexConfigOptions,
  overrides?: MediaServerAdapterOverrides,
): PlexConnectionResolution {
  const storeDependencies = resolveStoreDependencies(loadedConfig.auth);
  const rawUrl = overrides?.plexUrl ?? loadedConfig.url;

  // An explicitly-supplied empty `--plex-token` (or MCP `plexToken: ""`) is
  // refused outright, exactly as it was before an enrolled store existed. It
  // must never be treated as "no override": the cross-origin guard below is a
  // presence test on `overrides.plexToken`, so an empty string would satisfy
  // the guard while still falling through to the configured `plex.token` —
  // sending a real credential to a caller-supplied origin.
  if (overrides?.plexToken !== undefined && overrides.plexToken.length === 0) {
    return { ok: false, reason: "missing" };
  }

  const staticToken = overrides?.plexToken ?? loadedConfig.token;
  // Falsy, not `=== undefined`: an empty token has always meant "not configured"
  // here, and with no store on disk this stays byte-identical to the legacy gate.
  if (!rawUrl || (!staticToken && !plexAuthStoreExistsSync(storeDependencies))) {
    return { ok: false, reason: "missing" };
  }

  const origin = normalizePlexOrigin(rawUrl);
  if (origin === undefined) {
    return { ok: false, reason: "invalid-url" };
  }

  if (overrides?.plexUrl !== undefined && overrides.plexToken === undefined) {
    const configuredOrigin =
      loadedConfig.url === undefined ? undefined : normalizePlexOrigin(loadedConfig.url);
    if (configuredOrigin !== origin) {
      return { ok: false, reason: "cross-origin-override" };
    }
  }

  const selected = selectPlexCredential(loadedConfig, storeDependencies, origin, overrides);
  if (!selected.ok) {
    return selected;
  }

  return {
    ok: true,
    configuration: {
      origin,
      credential: selected.credential,
      clientIdentifier: selected.clientIdentifier,
      libraryName: overrides?.plexLibrary ?? loadedConfig.libraryName,
      libraries: loadedConfig.libraries,
      pageSize: loadedConfig.pageSize,
      cache: loadedConfig.cache,
    },
  };
}

function isScanEnabled(overrides?: MediaServerAdapterOverrides): boolean {
  const loadedConfig = getLoadedPlexConfig();
  return overrides?.plexScan !== undefined
    ? overrides.plexScan
    : (loadedConfig.scanAfterCopy ?? false);
}

function requiredResolutionError(
  reason: Exclude<PlexConnectionResolution, { ok: true }>["reason"],
): Error {
  switch (reason) {
    case "missing":
      return new Error(MISSING_PLEX_CONNECTION_MESSAGE);
    case "invalid-url":
      return new Error(INVALID_PLEX_URL_MESSAGE);
    case "cross-origin-override":
      return new Error(CROSS_ORIGIN_OVERRIDE_MESSAGE);
    case "ambiguous-credential":
      return new Error(AMBIGUOUS_PLEX_CREDENTIAL_MESSAGE);
    case "not-enrolled":
      return new PlexAuthError("PLEX_AUTH_NOT_ENROLLED");
  }
}

/**
 * Resolves the Plex connection, downgrading a typed credential-store failure to
 * a warning in `optional` mode only.
 *
 * `optional` mode is contractually forbidden from throwing, so an unusable store
 * degrades to "scan skipped" with the actionable cause logged. `required` mode
 * rethrows the typed error untouched — a caller that asked for an adapter must
 * see `chmod 600 …` rather than a generic "URL and token are required".
 */
function resolvePlexConnection(
  mode: MediaServerAdapterMode,
  options: CreateMediaServerAdapterOptions,
): PlexConnectionResolution | undefined {
  try {
    return buildPlexAdapterConfiguration(getLoadedPlexConfig(), options);
  } catch (error: unknown) {
    if (mode === "required" || !(error instanceof PlexAuthError)) {
      throw error;
    }
    logWarn(`${error.message} ${error.remediation}`);
    return undefined;
  }
}

/**
 * Creates a media server adapter.
 *
 * - `optional` mode: returns `undefined` when scan integration is disabled,
 *   missing credentials, or connection resolution is unsafe.
 * - `required` mode: throws on missing, invalid, or unsafe credentials.
 */
export function createMediaServerAdapter(
  options: CreateMediaServerAdapterOptions = {},
): MediaServerAdapter | undefined {
  const mode = options.mode ?? "optional";
  const serverType = resolveMediaServerType(options);

  if (serverType !== "plex") {
    throw new Error(`Unsupported media server type: ${serverType}`);
  }

  if (mode === "optional" && !isScanEnabled(options)) {
    return undefined;
  }

  const resolved = resolvePlexConnection(mode, options);
  if (resolved === undefined) {
    // Reachable in `optional` mode only; the typed cause is already logged.
    logWarn(OPTIONAL_SCAN_WARNING);
    return undefined;
  }

  if (!resolved.ok) {
    if (mode === "optional") {
      logWarn(OPTIONAL_SCAN_WARNING);
      return undefined;
    }
    throw requiredResolutionError(resolved.reason);
  }

  return new PlexAdapter(resolved.configuration);
}

/** Optional adapter creation mode for scan-gated workflows. */
export function createOptionalMediaServerAdapter(
  overrides: MediaServerAdapterOverrides = {},
): MediaServerAdapter | undefined {
  return createMediaServerAdapter({ ...overrides, mode: "optional" });
}

/** Required adapter creation mode for query/CRUD workflows. */
export function requireMediaServerAdapter(
  overrides: MediaServerAdapterOverrides = {},
): MediaServerAdapter {
  const adapter = createMediaServerAdapter({ ...overrides, mode: "required" });

  if (!adapter) {
    throw new Error("Media server adapter is required but unavailable");
  }

  return adapter;
}

/** Returns the currently configured media server type. */
export function getConfiguredMediaServerType(): MediaServerType {
  const config = getLoadedConfig();
  const hasPlexConfig = Boolean(config.plex?.url || config.plex?.token);
  return hasPlexConfig ? "plex" : DEFAULT_MEDIA_SERVER_TYPE;
}

export { PlexAdapter } from "./plex-adapter.js";
