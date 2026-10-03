/**
 * Live and offline orchestration for the read-only Plex-Lidarr reconciliation.
 *
 * Provider acquisition and cache lifecycle stay here; identity resolution and
 * classification remain pure bridge operations.
 */

import {
  requireMediaServerAdapter,
  resolveRequiredPlexOriginWithoutCredentials,
} from "../../lib/adapters/index.js";
import {
  findCompatibleBridgeIdentityScopes,
  readBridgeIdentitySnapshot,
  replaceBridgeIdentitySnapshot,
} from "../../lib/bridge/cache.js";
import { resolveArtistIdentities } from "../../lib/bridge/mapping.js";
import { reconcilePlexLidarrSnapshot } from "../../lib/bridge/reconcile.js";
import {
  closeDatabase,
  getDefaultDatabasePath,
  initializeDatabase,
  openDatabaseReadOnly,
} from "../../lib/db.js";
import {
  resolveLidarrScheduler,
  resolveRequiredLidarrClient,
  resolveRequiredLidarrOrigin,
  resolveRequiredLidarrOriginWithoutCredentials,
} from "../../lib/lidarr/index.js";
import { LidarrValidationError } from "../../lib/lidarr/errors.js";
import {
  BRIDGE_ARTIST_MAX_RECORDS,
  type BridgeArtistIdentitySnapshot,
  type BridgeIdentityCompatibleScopeResult,
  type PlexLidarrReconciliationResultV1,
} from "../../types/bridge.js";
import {
  MEDIA_IDENTITY_MAX_ID_BYTES,
  MEDIA_IDENTITY_MAX_PAGE_SIZE,
  type MediaArtistIdentity,
  type MediaIdentityPage,
  type MediaServerAdapter,
  type MediaServerIdentityCapability,
} from "../../types/media-server.js";
import type { LidarrClientApi } from "../../lib/lidarr/client.js";
import type {
  LidarrExecutionSuccessMetadata,
  LidarrScheduler,
} from "../../lib/lidarr/scheduler.js";
import type { LidarrArtist } from "../../types/lidarr.js";
import type { LidarrTier } from "../../lib/lidarr/tiers.js";
import type { DbConnection } from "../../types/db.js";

/** Reliability tier for live reconciliation. No upstream metadata lookup occurs. */
export const TIER: LidarrTier = "local-only";

const OPERATION = "lidarr reconcile";
const PLEX_PAGE_SIZE = MEDIA_IDENTITY_MAX_PAGE_SIZE;
const UNSAFE_ID_PATTERN = /[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/u;

/** Inputs for one live or explicit offline reconciliation. */
export interface LidarrReconcileActionOptions {
  /** Explicit Plex music-library name or identifier required by live mode. */
  readonly plexLibrary?: string;
  /** Optional stable cached library identifier used only to narrow offline scope. */
  readonly plexLibraryId?: string;
  /** Read exactly one compatible cached snapshot without provider construction. */
  readonly offline?: boolean;
  /** Include bridge-owned duplicate identity evidence. */
  readonly duplicates?: boolean;
  readonly plexUrl?: string;
  readonly plexToken?: string;
  readonly lidarrUrl?: string;
  readonly lidarrApiKey?: string;
  /** Test/embedding override; normal CLI use resolves the default tracking database. */
  readonly databasePath?: string;
  /** Caller cancellation propagated through scheduling and every provider read. */
  readonly signal?: AbortSignal;
}

/** Action result shared by live and offline presentation. */
export interface LidarrReconcileActionResult {
  readonly report: PlexLidarrReconciliationResultV1;
  /** Present only for the scheduled live path. */
  readonly execution?: LidarrExecutionSuccessMetadata;
}

/** Injectable ownership seams used by focused lifecycle tests. */
export interface LidarrReconcileDependencies {
  readonly requireMediaServerAdapter: typeof requireMediaServerAdapter;
  readonly resolvePlexOrigin: typeof resolveRequiredPlexOriginWithoutCredentials;
  readonly resolveLidarrOrigin: typeof resolveRequiredLidarrOrigin;
  readonly resolveLidarrOriginWithoutCredentials: typeof resolveRequiredLidarrOriginWithoutCredentials;
  readonly resolveLidarrClient: typeof resolveRequiredLidarrClient;
  readonly resolveScheduler: () => Pick<LidarrScheduler, "runSingle">;
  readonly initializeDatabase: typeof initializeDatabase;
  readonly openDatabaseReadOnly: typeof openDatabaseReadOnly;
  readonly closeDatabase: typeof closeDatabase;
  readonly defaultDatabasePath: typeof getDefaultDatabasePath;
  readonly findCompatibleScopes: typeof findCompatibleBridgeIdentityScopes;
  readonly readSnapshot: typeof readBridgeIdentitySnapshot;
  readonly replaceSnapshot: typeof replaceBridgeIdentitySnapshot;
  readonly resolveIdentities: typeof resolveArtistIdentities;
  readonly reconcileSnapshot: typeof reconcilePlexLidarrSnapshot;
  readonly now: () => Date;
}

const DEFAULT_DEPENDENCIES: LidarrReconcileDependencies = Object.freeze({
  requireMediaServerAdapter,
  resolvePlexOrigin: resolveRequiredPlexOriginWithoutCredentials,
  resolveLidarrOrigin: resolveRequiredLidarrOrigin,
  resolveLidarrOriginWithoutCredentials: resolveRequiredLidarrOriginWithoutCredentials,
  resolveLidarrClient: resolveRequiredLidarrClient,
  resolveScheduler: resolveLidarrScheduler,
  initializeDatabase,
  openDatabaseReadOnly,
  closeDatabase,
  defaultDatabasePath: getDefaultDatabasePath,
  findCompatibleScopes: findCompatibleBridgeIdentityScopes,
  readSnapshot: readBridgeIdentitySnapshot,
  replaceSnapshot: replaceBridgeIdentitySnapshot,
  resolveIdentities: resolveArtistIdentities,
  reconcileSnapshot: reconcilePlexLidarrSnapshot,
  now: () => new Date(),
});

function validation(message: string, code: "validation" | "invalid-response" | "configuration") {
  return new LidarrValidationError(OPERATION, message, code);
}

function requireLiveLibrary(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw validation(
      "A non-empty Plex music library selector is required for live reconciliation.",
      "configuration",
    );
  }
  return value.trim();
}

function requireIdentityCapability(adapter: MediaServerAdapter): MediaServerIdentityCapability {
  if (adapter.identity === undefined) {
    throw validation(
      "The configured media server does not provide artist identity capability.",
      "configuration",
    );
  }
  return adapter.identity;
}

interface PlexArtistEnumerationState {
  readonly artists: MediaArtistIdentity[];
  readonly ids: Set<string>;
  libraryId?: string;
  expectedTotal?: number;
}

function validatePlexArtistPage(page: MediaIdentityPage, requestedOffset: number): void {
  if (
    page.libraryId.length === 0 ||
    new TextEncoder().encode(page.libraryId).byteLength > MEDIA_IDENTITY_MAX_ID_BYTES ||
    UNSAFE_ID_PATTERN.test(page.libraryId) ||
    !Number.isSafeInteger(page.offset) ||
    page.offset !== requestedOffset ||
    !Number.isSafeInteger(page.returned) ||
    page.returned < 0 ||
    page.returned !== page.items.length ||
    !Number.isSafeInteger(page.total) ||
    page.total < 0 ||
    page.total > BRIDGE_ARTIST_MAX_RECORDS ||
    page.offset + page.returned > page.total
  ) {
    throw validation(
      "Plex returned invalid artist identity pagination metadata.",
      "invalid-response",
    );
  }
}

function accumulatePlexArtistPage(
  state: PlexArtistEnumerationState,
  page: MediaIdentityPage,
): void {
  if (state.libraryId !== undefined && page.libraryId !== state.libraryId) {
    throw validation("Plex artist identity scope changed during pagination.", "invalid-response");
  }
  if (state.expectedTotal !== undefined && page.total !== state.expectedTotal) {
    throw validation("Plex artist identity total changed during pagination.", "invalid-response");
  }
  state.libraryId ??= page.libraryId;
  state.expectedTotal ??= page.total;

  for (const artist of page.items) {
    if (state.ids.has(artist.id)) {
      throw validation("Plex returned duplicate artist identities.", "invalid-response");
    }
    state.ids.add(artist.id);
    state.artists.push(artist);
  }
  if (state.artists.length > BRIDGE_ARTIST_MAX_RECORDS) {
    throw validation(
      "Plex artist identity catalog exceeds the supported bound.",
      "invalid-response",
    );
  }
}

async function listCompletePlexArtists(
  identity: MediaServerIdentityCapability,
  library: string,
  signal: AbortSignal | undefined,
): Promise<{ readonly libraryId: string; readonly artists: readonly MediaArtistIdentity[] }> {
  const state: PlexArtistEnumerationState = {
    artists: [],
    ids: new Set<string>(),
  };
  let offset = 0;

  while (true) {
    signal?.throwIfAborted();
    const page = await identity.listArtists({
      library,
      limit: PLEX_PAGE_SIZE,
      offset,
      ...(signal === undefined ? {} : { signal }),
    });
    signal?.throwIfAborted();

    validatePlexArtistPage(page, offset);
    accumulatePlexArtistPage(state, page);

    const nextOffset = page.offset + page.returned;
    if (!page.hasMore) {
      if (
        nextOffset !== page.total ||
        state.artists.length !== page.total ||
        state.libraryId === undefined
      ) {
        throw validation("Plex artist identity enumeration was incomplete.", "invalid-response");
      }
      return Object.freeze({
        libraryId: state.libraryId,
        artists: Object.freeze(state.artists),
      });
    }
    if (page.returned <= 0 || nextOffset <= offset || nextOffset >= page.total) {
      throw validation(
        "Plex artist identity pagination did not make forward progress.",
        "invalid-response",
      );
    }
    offset = nextOffset;
  }
}

interface LiveReconcileDependencies {
  readonly library: string;
  readonly plexOrigin: string;
  readonly lidarrOrigin: string;
  readonly identity: MediaServerIdentityCapability;
  readonly client: LidarrClientApi;
}

interface LiveArtistAcquisition {
  readonly plexInstanceId: string;
  readonly plex: {
    readonly libraryId: string;
    readonly artists: readonly MediaArtistIdentity[];
  };
  readonly lidarrArtists: readonly LidarrArtist[];
}

function resolveLiveDependencies(
  options: LidarrReconcileActionOptions,
  dependencies: LidarrReconcileDependencies,
): LiveReconcileDependencies {
  const library = requireLiveLibrary(options.plexLibrary);
  const plexOverrides = {
    plexUrl: options.plexUrl,
    plexToken: options.plexToken,
    plexLibrary: library,
  };
  const lidarrOverrides = {
    lidarrUrl: options.lidarrUrl,
    lidarrApiKey: options.lidarrApiKey,
  };
  return {
    library,
    plexOrigin: dependencies.resolvePlexOrigin({ plexUrl: options.plexUrl }),
    lidarrOrigin: dependencies.resolveLidarrOrigin(lidarrOverrides),
    identity: requireIdentityCapability(dependencies.requireMediaServerAdapter(plexOverrides)),
    client: dependencies.resolveLidarrClient(lidarrOverrides, { tier: TIER }),
  };
}

async function acquireLiveArtists(
  live: LiveReconcileDependencies,
  signal: AbortSignal | undefined,
): Promise<LiveArtistAcquisition> {
  signal?.throwIfAborted();
  const plexInstanceId = await live.identity.getInstanceId(
    signal === undefined ? undefined : { signal },
  );
  const plex = await listCompletePlexArtists(live.identity, live.library, signal);
  signal?.throwIfAborted();
  const lidarrArtists = await live.client.listArtists(signal);
  signal?.throwIfAborted();
  if (lidarrArtists.length > BRIDGE_ARTIST_MAX_RECORDS) {
    throw validation("Lidarr artist catalog exceeds the supported bound.", "invalid-response");
  }
  return { plexInstanceId, plex, lidarrArtists };
}

function createLiveSnapshot(
  live: LiveReconcileDependencies,
  acquisition: LiveArtistAcquisition,
  dependencies: LidarrReconcileDependencies,
): BridgeArtistIdentitySnapshot {
  const capturedAt = dependencies.now().toISOString();
  return dependencies.resolveIdentities({
    scope: {
      plexOrigin: live.plexOrigin,
      plexInstanceId: acquisition.plexInstanceId,
      plexLibraryId: acquisition.plex.libraryId,
      lidarrOrigin: live.lidarrOrigin,
      entityKind: "artist",
    },
    sourceArtists: acquisition.plex.artists,
    targetArtists: acquisition.lidarrArtists,
    sourceComplete: true,
    targetComplete: true,
    capturedAt,
    verifiedAt: capturedAt,
  });
}

function requireExactlyOneScope(
  scopes: readonly BridgeIdentityCompatibleScopeResult[],
): BridgeIdentityCompatibleScopeResult {
  if (scopes.length === 0) {
    throw validation(
      "missing-compatible-snapshot: no compatible complete reconciliation snapshot was found.",
      "validation",
    );
  }
  if (scopes.length !== 1) {
    const candidates = scopes
      .slice(0, 3)
      .map(
        ({ scope, capturedAt, ageSeconds }) =>
          `${scope.plexLibraryId.slice(0, 80)}@${capturedAt} (${ageSeconds}s old)`,
      )
      .join(", ");
    throw validation(
      `ambiguous-snapshot-scope: multiple compatible snapshots were found (${candidates}).`,
      "validation",
    );
  }
  return scopes[0]!;
}

async function persistSnapshot(
  snapshot: BridgeArtistIdentitySnapshot,
  databasePath: string,
  dependencies: LidarrReconcileDependencies,
  signal: AbortSignal | undefined,
): Promise<void> {
  signal?.throwIfAborted();
  const database = await dependencies.initializeDatabase(databasePath);
  try {
    signal?.throwIfAborted();
    dependencies.replaceSnapshot(database, snapshot);
  } finally {
    dependencies.closeDatabase(database);
  }
}

async function executeLive(
  options: LidarrReconcileActionOptions,
  dependencies: LidarrReconcileDependencies,
): Promise<LidarrReconcileActionResult> {
  const live = resolveLiveDependencies(options, dependencies);

  const scheduled = await dependencies.resolveScheduler().runSingle(
    TIER,
    {
      id: "lidarr-reconcile",
      operation: OPERATION,
      idempotent: true,
      run: async ({ signal }): Promise<PlexLidarrReconciliationResultV1> => {
        const acquisition = await acquireLiveArtists(live, signal);
        const snapshot = createLiveSnapshot(live, acquisition, dependencies);
        const report = dependencies.reconcileSnapshot(snapshot, {
          includeDuplicates: options.duplicates === true,
        });
        signal?.throwIfAborted();
        await persistSnapshot(
          snapshot,
          options.databasePath ?? dependencies.defaultDatabasePath(),
          dependencies,
          signal,
        );
        return report;
      },
    },
    options.signal === undefined ? undefined : { signal: options.signal },
  );

  return Object.freeze({
    report: scheduled.value,
    execution: Object.freeze({ ...scheduled.execution }),
  });
}

function executeOffline(
  options: LidarrReconcileActionOptions,
  dependencies: LidarrReconcileDependencies,
): LidarrReconcileActionResult {
  options.signal?.throwIfAborted();
  const plexOrigin = dependencies.resolvePlexOrigin({ plexUrl: options.plexUrl });
  const lidarrOrigin = dependencies.resolveLidarrOriginWithoutCredentials({
    lidarrUrl: options.lidarrUrl,
  });
  options.signal?.throwIfAborted();

  const database = dependencies.openDatabaseReadOnly(
    options.databasePath ?? dependencies.defaultDatabasePath(),
  );
  try {
    options.signal?.throwIfAborted();
    const selected = requireExactlyOneScope(
      dependencies.findCompatibleScopes(
        database,
        {
          plexOrigin,
          lidarrOrigin,
          entityKind: "artist",
          ...(options.plexLibraryId === undefined ? {} : { plexLibraryId: options.plexLibraryId }),
        },
        dependencies.now,
      ),
    );
    options.signal?.throwIfAborted();
    const snapshot = dependencies.readSnapshot(database, selected.scope, dependencies.now);
    if (snapshot === undefined) {
      throw validation(
        "missing-compatible-snapshot: the selected reconciliation snapshot no longer exists.",
        "validation",
      );
    }
    options.signal?.throwIfAborted();
    return Object.freeze({
      report: dependencies.reconcileSnapshot(snapshot, {
        includeDuplicates: options.duplicates === true,
      }),
    });
  } finally {
    dependencies.closeDatabase(database);
  }
}

/**
 * Executes one cancellable reconciliation in either strict live or offline mode.
 */
export async function executeLidarrReconcile(
  options: LidarrReconcileActionOptions,
  dependencies: LidarrReconcileDependencies = DEFAULT_DEPENDENCIES,
): Promise<LidarrReconcileActionResult> {
  options.signal?.throwIfAborted();
  return options.offline === true
    ? executeOffline(options, dependencies)
    : await executeLive(options, dependencies);
}
