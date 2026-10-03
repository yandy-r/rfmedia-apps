import type {
  MediaServerAdapter,
  MediaServerCapabilities,
  MediaServerFeatures,
} from "../../types/media-server.js";
import type { PlexCacheConfig, PlexLibraryMapping } from "../../types/config.js";
import { StaticPlexTokenProvider } from "./plex/auth.js";
import type { PlexTokenProvider } from "./plex/auth.js";
import { createPlexResponseCache } from "./plex/cache.js";
import { PlexClient } from "./plex/client.js";
import { createPlexCollectionCapability } from "./plex/collections.js";
import { createPlexIdentityCapability } from "./plex/identity.js";
import { PlexJwtTokenProvider } from "./plex/jwt-provider.js";
import { createPlexMetadataCapability } from "./plex/metadata.js";
import { createPlexPlaylistCapability } from "./plex/playlists.js";
import { createPlexQueryLibraryFamily } from "./plex/query-library.js";
import {
  createPlexConnectionSettings,
  createPlexRotatingConnectionSettings,
} from "./plex/types.js";
import type { PlexConnectionInput, PlexConnectionSettings } from "./plex/types.js";

/*
 * ── THE ARCHITECTURE-GATE FAÇADE (issue #251) ───────────────────────────────
 *
 * This module is the sole `PRIVATE_PLEX_COMPOSER`
 * (`scripts/check-direct-plex-imports.mjs`), which makes it the ONLY production
 * module outside `src/lib/adapters/plex/` allowed to import from that directory.
 * `MODULE_SPECIFIER_PATTERN` in that script is raw text, so `import type` is NOT
 * exempt: a `./plex/*` specifier anywhere else raises `private-plex-import`,
 * which fails `check:architecture` and therefore fails BOTH `typecheck` and
 * `build` (it runs under `pretypecheck` and `prebuild`).
 *
 * Every upper layer — `adapters/index.ts`, `actions/plex-auth.ts`,
 * `commands/plex-auth.ts`, `actions/lidarr/audit-plex.ts`, and
 * `lib/error-formatters.ts` — must therefore import its Plex credential,
 * enrollment, and error symbols from HERE. A consumer that needs a symbol which
 * is not re-exported below must have it ADDED here; it must never add a direct
 * `./plex/*` import.
 *
 * Nothing that would let a caller compose its own transport (`PlexClient`, the
 * capability factories, the enrollment wire client) is re-exported. The surface
 * below is deliberately limited to credential custody, enrollment use-cases, and
 * their typed errors.
 */

export { PlexAuthError } from "./plex/errors.js";
export type { PlexAuthErrorCode, PlexAuthErrorOptions } from "./plex/errors.js";

export {
  PLEX_AUTH_DEFAULT_REFRESH_MARGIN_SECONDS,
  PLEX_AUTH_EXPIRY_SKEW_TOLERANCE_SECONDS,
  PLEX_AUTH_STORE_SCHEMA,
  loadPlexAuthStoreSync,
  plexAuthStoreExistsSync,
  readStoredCredential,
  resolvePlexAuthLockPath,
  resolvePlexAuthStorePath,
} from "./plex/credential-store.js";
export type {
  PlexAuthorizedOrigin,
  PlexAuthStoreDependencies,
  PlexAuthStoreHandle,
  PlexAuthStoreLockBudget,
  PlexCredentialState,
  PlexCredentialTiming,
} from "./plex/credential-store.js";

export {
  PLEX_AUTHORIZED_DEVICES_URL,
  enrollPlexClient,
  forgetPlexEnrollment,
  readPlexAuthStatus,
  refreshPlexCredential,
} from "./plex/enrollment.js";
export type {
  PlexAuthStatusCredential,
  PlexAuthStatusOptions,
  PlexAuthStatusResult,
  PlexEnrollmentDependencies,
  PlexEnrollmentOptions,
  PlexEnrollmentResult,
  PlexForgetOptions,
  PlexForgetResult,
  PlexRefreshOptions,
  PlexRefreshReason,
  PlexRefreshResult,
} from "./plex/enrollment.js";

export { PlexJwtWireError } from "./plex/jwt-wire.js";
export type { PlexJwtWireErrorCode } from "./plex/jwt-wire.js";

export { rotatePlexCredentialCell } from "./plex/credential-cell.js";
export type { PlexCredentialCell } from "./plex/credential-cell.js";

export {
  createPlexConnectionSettings,
  createPlexRotatingConnectionSettings,
  getPlexConnectionCredentialCell,
  getPlexConnectionToken,
  toPlexConnectionLogContext,
} from "./plex/types.js";
export type {
  PlexConnectionInput,
  PlexConnectionLogContext,
  PlexConnectionSettings,
} from "./plex/types.js";

/**
 * Non-secret Plex client identity used when no enrolled identity is available.
 *
 * Precedence branches that carry a static token (`--plex-token`, `plex.token`)
 * have no credential store and therefore no persisted UUIDv4, so this static
 * default is what `createPlexConnectionSettings` receives for them. It never
 * reaches the wire — `PlexClient`'s header set is `{Accept, X-Plex-Token}`.
 */
export const PLEX_CLIENT_IDENTIFIER = "rfmedia-cli";

const DEFAULT_CACHE_TTL_SECONDS = 300;

const PLEX_CAPABILITIES: MediaServerCapabilities = Object.freeze({
  query: true,
  library: true,
  scan: true,
  playlist: true,
  collection: true,
  metadata: true,
});

const PLEX_FEATURES = Object.freeze({
  ratings: Object.freeze({
    readable: true,
    writable: true,
    normalized: true,
    nativeScale: Object.freeze({ min: 0, max: 10, step: 1 }),
  }),
  smartPlaylists: true,
  smartCollections: true,
  pathScopedScans: true,
  filterPushdown: Object.freeze({
    supported: true,
    fields: Object.freeze([
      "album",
      "albumRating",
      "artist",
      "artistRating",
      "genre",
      "maxYear",
      "minPlays",
      "minYear",
      "mood",
      "style",
      "title",
      "trackRating",
      "year",
    ] as const),
    operators: Object.freeze([">=", "<=", "==", "!=", "contains", "not_contains"] as const),
  }),
  sonicAnalysis: "server-dependent",
} satisfies MediaServerFeatures);

/**
 * How one adapter instance obtains and maintains its bearer credential.
 *
 * Both variants carry an ALREADY RESOLVED opaque token, never a live store
 * handle: reading a stored credential can throw `PlexAuthError`, and
 * `createOptionalMediaServerAdapter` must answer `undefined` + `logWarn` rather
 * than throw. The resolution therefore happens in `adapters/index.ts`, where the
 * `not-enrolled` failure reason already lives, and only its result arrives here.
 *
 * The `enrolled` variant additionally carries the coordinates the rotating
 * provider needs to mint the credential's successor without rebuilding the
 * adapter.
 */
export type PlexAdapterCredential =
  | { readonly kind: "static"; readonly token: string }
  | {
      readonly kind: "enrolled";
      readonly token: string;
      /** Absolute path of the credential store backing the rotation. */
      readonly storePath: string;
      /** Seconds before expiry at which the provider refreshes proactively. */
      readonly refreshMarginSeconds: number;
    };

/**
 * Resolved, validated settings consumed while composing one Plex adapter.
 *
 * For a `static` credential these settings are consumed once and never consulted
 * again. For an `enrolled` credential the adapter keeps a rotating connection
 * alive for its whole lifetime, so `credential.storePath` and
 * `credential.refreshMarginSeconds` remain live inputs to every later refresh
 * rather than one-shot construction arguments.
 */
export interface PlexAdapterConfiguration {
  readonly origin: string;
  readonly credential: PlexAdapterCredential;
  /**
   * Enrolled installs supply the UUIDv4 minted at enrollment; static branches
   * omit it and fall back to {@link PLEX_CLIENT_IDENTIFIER}.
   */
  readonly clientIdentifier?: string;
  readonly libraryName?: string;
  readonly libraries?: readonly PlexLibraryMapping[];
  readonly pageSize?: number;
  readonly cache?: PlexCacheConfig;
}

/** One credential source resolved into the pair the transport is built from. */
interface PlexCredentialBinding {
  readonly connection: PlexConnectionSettings;
  readonly tokenProvider: PlexTokenProvider;
}

/**
 * Selects BOTH the connection kind and the token provider from one credential.
 *
 * The two choices are inseparable: `PlexJwtTokenProvider` rotates the connection's
 * credential cell in place, and a cell built by `createPlexConnectionSettings` is
 * not rotatable, so pairing the JWT provider with a static connection would throw
 * `TypeError` on the first refresh instead of at composition time.
 *
 * @param configuration - Resolved origin, credential, and captured settings.
 * @returns The frozen connection plus the provider bound to it.
 */
function bindPlexCredential(configuration: PlexAdapterConfiguration): PlexCredentialBinding {
  const { credential } = configuration;
  const input: PlexConnectionInput = {
    origin: configuration.origin,
    token: credential.token,
    clientIdentifier: configuration.clientIdentifier ?? PLEX_CLIENT_IDENTIFIER,
    cache: {
      enabled: configuration.cache?.enabled ?? false,
      ttlSeconds: configuration.cache?.ttlSeconds ?? DEFAULT_CACHE_TTL_SECONDS,
    },
  };

  if (credential.kind === "enrolled") {
    const connection = createPlexRotatingConnectionSettings(input);
    return {
      connection,
      tokenProvider: new PlexJwtTokenProvider(connection, {
        storePath: credential.storePath,
        refreshMarginSeconds: credential.refreshMarginSeconds,
      }),
    };
  }

  const connection = createPlexConnectionSettings(input);
  return { connection, tokenProvider: new StaticPlexTokenProvider(connection) };
}

/**
 * Sole public Plex implementation of the provider-neutral media-server contract.
 *
 * Construction creates one origin-bound client and one adapter-local cache, then
 * composes every endpoint family around those shared private dependencies. Raw
 * credentials and the Plex machine identifier never become adapter properties.
 */
export class PlexAdapter implements MediaServerAdapter {
  readonly type = "plex" as const;
  readonly capabilities: MediaServerCapabilities = PLEX_CAPABILITIES;
  readonly features: MediaServerFeatures = PLEX_FEATURES;
  readonly query;
  readonly library;
  readonly scan;
  readonly identity;
  readonly playlist;
  readonly collection;
  readonly metadata;

  /**
   * Composes one isolated Plex adapter from an already validated connection.
   *
   * Construction never fails for credential reasons — an unusable or absent
   * credential is reported by the resolver in `adapters/index.ts` so that
   * `createOptionalMediaServerAdapter` keeps its "return `undefined`, never
   * throw" contract. Credential-lifecycle failures surface from `getToken()`.
   *
   * @param configuration - Canonical origin, resolved credential, and captured
   *   behavior settings.
   */
  constructor(configuration: PlexAdapterConfiguration) {
    const { connection, tokenProvider } = bindPlexCredential(configuration);
    const transport = new PlexClient(connection, tokenProvider);
    const cache = createPlexResponseCache(connection.cache);
    const queryLibrary = createPlexQueryLibraryFamily({
      transport,
      cache,
      defaultLibraryName: configuration.libraryName,
      libraryMappings: configuration.libraries,
      pageSize: configuration.pageSize,
    });

    this.query = queryLibrary.query;
    this.library = queryLibrary.library;
    this.scan = queryLibrary.scan;
    this.identity = createPlexIdentityCapability({
      transport,
      findLibrary: queryLibrary.findLibrary,
      getMachineIdentifier: queryLibrary.getMachineIdentifier,
      pageSize: configuration.pageSize,
    });
    this.playlist = createPlexPlaylistCapability({
      transport,
      cache,
      getMachineIdentifier: queryLibrary.getMachineIdentifier,
      pageSize: configuration.pageSize,
    });
    this.collection = createPlexCollectionCapability(
      transport,
      cache,
      queryLibrary.getMachineIdentifier,
      { pageSize: configuration.pageSize },
    );
    this.metadata = createPlexMetadataCapability(transport, cache);

    Object.freeze(this);
  }
}
