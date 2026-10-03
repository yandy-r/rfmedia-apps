import {
  MediaServerError,
  type MediaPlaylist,
  type MediaServerPlaylistCapability,
  type MediaTrack,
} from "../../../types/media-server.js";
import { logWarn } from "../../logger.js";
import type { PlexResponseCache } from "./cache.js";
import type { PlexTransport } from "./client.js";
import { mapPlexPlaylist, mapPlexTrack } from "./mappers.js";
import {
  isPlexWireMetadataResponse,
  isPlexWirePlaylist,
  isPlexWireTrack,
  type PlexWireMetadataResponse,
  type PlexWirePlaylist,
  type PlexWireTrack,
} from "./types.js";

const DEFAULT_PAGE_SIZE = 100;
const PLAYLIST_ADD_BATCH_SIZE = 10_000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

const OPERATIONS = Object.freeze({
  list: "list Plex playlists",
  find: "find Plex playlist",
  tracks: "fetch Plex playlist tracks",
  create: "create Plex playlist",
  addTracks: "add tracks to Plex playlist",
  delete: "delete Plex playlist",
} as const);

/** Private dependencies for the Plex playlist endpoint family. */
export interface PlexPlaylistCapabilityDependencies {
  readonly transport: PlexTransport;
  readonly cache: PlexResponseCache;
  /** Injected from the query/library family to avoid a private-family import cycle. */
  readonly getMachineIdentifier: () => Promise<string>;
  readonly pageSize?: number;
  readonly warn?: (message: string) => void;
  readonly now?: () => number;
}

interface BoundPlexPlaylistCapabilityDependencies {
  readonly transport: PlexTransport;
  readonly cache: PlexResponseCache;
  readonly getMachineIdentifier: () => Promise<string>;
  readonly pageSize: number;
  readonly warn: (message: string) => void;
  readonly now: () => number;
}

function mediaServerError(
  operation: string,
  code: "configuration" | "not-found" | "invalid-response",
  message: string,
): MediaServerError {
  return new MediaServerError(message, {
    code,
    serverType: "plex",
    operation,
    retryable: false,
  });
}

function validatePageSize(pageSize: number): number {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new TypeError("Plex playlist page size must be a positive safe integer");
  }
  return pageSize;
}

function encodeOpaqueId(id: string, operation: string, label: string): string {
  if (id.length === 0 || CONTROL_CHARACTERS.test(id)) {
    throw mediaServerError(operation, "configuration", `${label} must be a non-empty opaque ID`);
  }
  return encodeURIComponent(id);
}

function sourceUri(machineIdentifier: string, itemIds?: readonly string[]): string {
  const encodedMachineIdentifier = encodeOpaqueId(
    machineIdentifier,
    itemIds === undefined ? OPERATIONS.create : OPERATIONS.addTracks,
    "Plex machine identifier",
  );
  const base = `server://${encodedMachineIdentifier}/com.plexapp.plugins.library`;
  if (itemIds === undefined) {
    return base;
  }
  const encodedItemIds = itemIds.map((id) => encodeOpaqueId(id, OPERATIONS.addTracks, "Track ID"));
  return `${base}/library/metadata/${encodedItemIds.join(",")}`;
}

function mapPlaylists(body: unknown, operation: string): readonly MediaPlaylist[] {
  if (!isPlexWireMetadataResponse(body, isPlexWirePlaylist)) {
    throw mediaServerError(operation, "invalid-response", "Plex returned invalid playlist data");
  }
  return Object.freeze(
    (body.MediaContainer.Metadata ?? [])
      .filter((playlist) => playlist.playlistType === "audio")
      .map(mapPlexPlaylist),
  );
}

function mapTracks(
  body: unknown,
  operation: string,
): {
  readonly tracks: readonly MediaTrack[];
  readonly returned: number;
  readonly total: number;
} {
  if (!isPlexWireMetadataResponse(body, isPlexWireTrack)) {
    throw mediaServerError(operation, "invalid-response", "Plex returned invalid playlist tracks");
  }

  const metadata = body.MediaContainer.Metadata ?? [];
  let tracks: readonly MediaTrack[];
  try {
    tracks = metadata.map(mapPlexTrack);
  } catch {
    throw mediaServerError(operation, "invalid-response", "Plex returned invalid playlist tracks");
  }
  return {
    tracks,
    returned: metadata.length,
    total: body.MediaContainer.totalSize ?? metadata.length,
  };
}

function mapCreatedPlaylist(body: unknown, smart: boolean, now: () => number): MediaPlaylist {
  if (!isPlexWireMetadataResponse(body, isPlexWirePlaylist)) {
    throw mediaServerError(
      OPERATIONS.create,
      "invalid-response",
      "Playlist creation response contained invalid playlist data",
    );
  }
  const playlist = body.MediaContainer.Metadata?.[0];
  if (playlist === undefined) {
    throw mediaServerError(
      OPERATIONS.create,
      "invalid-response",
      "Playlist creation response did not contain playlist metadata",
    );
  }
  const timestamp = Math.floor(now() / 1_000);
  return mapPlexPlaylist({
    ...playlist,
    smart: playlist.smart ?? smart,
    addedAt: playlist.addedAt ?? timestamp,
    updatedAt: playlist.updatedAt ?? timestamp,
  });
}

async function requestPlaylistMetadata(
  transport: PlexTransport,
): Promise<PlexWireMetadataResponse<PlexWirePlaylist>> {
  return transport.request<PlexWireMetadataResponse<PlexWirePlaylist>>({
    path: "/playlists",
    operation: OPERATIONS.list,
  });
}

async function requestPlaylistTracks(
  transport: PlexTransport,
  playlistPathId: string,
  offset: number,
  pageSize: number,
): Promise<PlexWireMetadataResponse<PlexWireTrack>> {
  return transport.request<PlexWireMetadataResponse<PlexWireTrack>>({
    path: `/playlists/${playlistPathId}/items`,
    operation: OPERATIONS.tracks,
    options: {
      query: {
        "X-Plex-Container-Start": offset,
        "X-Plex-Container-Size": pageSize,
      },
    },
  });
}

function createPlaylistList(
  dependencies: BoundPlexPlaylistCapabilityDependencies,
): MediaServerPlaylistCapability["list"] {
  const { transport, cache } = dependencies;
  return async () => {
    const cacheKey = { category: "playlists" } as const;
    const cached = cache.get<readonly MediaPlaylist[]>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const body: unknown = await requestPlaylistMetadata(transport);
    const playlists = mapPlaylists(body, OPERATIONS.list);
    cache.set(cacheKey, playlists);
    return playlists;
  };
}

function createPlaylistByName(
  list: MediaServerPlaylistCapability["list"],
): MediaServerPlaylistCapability["byName"] {
  return async (name) => {
    const playlists = await list();
    const normalizedName = name.toLowerCase();
    const playlist = playlists.find(
      (candidate) => candidate.title.toLowerCase() === normalizedName,
    );
    if (playlist !== undefined) {
      return playlist;
    }
    const available =
      playlists.length > 0
        ? playlists.map((candidate) => candidate.title).join(", ")
        : "(no audio playlists found)";
    throw mediaServerError(
      OPERATIONS.find,
      "not-found",
      `Playlist "${name}" not found. Available audio playlists: ${available}`,
    );
  };
}

function createPlaylistTrackReader(
  dependencies: BoundPlexPlaylistCapabilityDependencies,
): MediaServerPlaylistCapability["tracks"] {
  const { transport, pageSize } = dependencies;
  return async (id) => {
    const playlistPathId = encodeOpaqueId(id, OPERATIONS.tracks, "Playlist ID");
    const tracks: MediaTrack[] = [];
    let offset = 0;

    while (true) {
      const body: unknown = await requestPlaylistTracks(
        transport,
        playlistPathId,
        offset,
        pageSize,
      );
      const page = mapTracks(body, OPERATIONS.tracks);
      tracks.push(...page.tracks);
      if (page.returned === 0) {
        break;
      }
      offset += page.returned;
      if (offset >= page.total) {
        break;
      }
    }

    return tracks;
  };
}

function createPlaylistCreator(
  dependencies: BoundPlexPlaylistCapabilityDependencies,
): MediaServerPlaylistCapability["create"] {
  const { transport, cache, getMachineIdentifier, now } = dependencies;
  return async (name, options) => {
    const smart = options?.smart ?? false;
    const machineIdentifier = await getMachineIdentifier();
    const body: unknown = await transport.request<unknown>({
      path: "/playlists",
      operation: OPERATIONS.create,
      options: {
        method: "POST",
        query: {
          title: name,
          smart: smart ? "1" : "0",
          type: "audio",
          uri: sourceUri(machineIdentifier),
        },
      },
    });
    const playlist = mapCreatedPlaylist(body, smart, now);
    cache.invalidate("playlists");
    return playlist;
  };
}

function warnAboutPlaylistTrackBatches(trackCount: number, warn: (message: string) => void): void {
  const batchCount = Math.ceil(trackCount / PLAYLIST_ADD_BATCH_SIZE);
  if (batchCount <= 1) {
    return;
  }
  const finalBatchSize = trackCount % PLAYLIST_ADD_BATCH_SIZE || PLAYLIST_ADD_BATCH_SIZE;
  warn(
    `Warning: Adding ${trackCount} tracks requires ${batchCount} batches. ` +
      `Due to Plex API behavior, only the last batch of ${finalBatchSize} tracks may be retained.`,
  );
}

async function addPlaylistTrackBatches(
  dependencies: BoundPlexPlaylistCapabilityDependencies,
  playlistPathId: string,
  machineIdentifier: string,
  trackIds: readonly string[],
): Promise<void> {
  const { transport, cache } = dependencies;
  let confirmedMutation = false;
  try {
    for (let start = 0; start < trackIds.length; start += PLAYLIST_ADD_BATCH_SIZE) {
      const batch = trackIds.slice(start, start + PLAYLIST_ADD_BATCH_SIZE);
      await transport.request<void>({
        path: `/playlists/${playlistPathId}/items`,
        operation: OPERATIONS.addTracks,
        options: {
          method: "PUT",
          query: { uri: sourceUri(machineIdentifier, batch) },
        },
      });
      confirmedMutation = true;
    }
  } finally {
    if (confirmedMutation) {
      cache.invalidate("playlists");
    }
  }
}

function createPlaylistTrackAdder(
  dependencies: BoundPlexPlaylistCapabilityDependencies,
): MediaServerPlaylistCapability["addTracks"] {
  const { getMachineIdentifier, warn } = dependencies;
  return async (id, trackIds) => {
    if (trackIds.length === 0) {
      return;
    }

    const playlistPathId = encodeOpaqueId(id, OPERATIONS.addTracks, "Playlist ID");
    const machineIdentifier = await getMachineIdentifier();
    warnAboutPlaylistTrackBatches(trackIds.length, warn);
    await addPlaylistTrackBatches(dependencies, playlistPathId, machineIdentifier, trackIds);
  };
}

function createPlaylistDeleter(
  dependencies: BoundPlexPlaylistCapabilityDependencies,
): MediaServerPlaylistCapability["delete"] {
  const { transport, cache } = dependencies;
  return async (id) => {
    const playlistPathId = encodeOpaqueId(id, OPERATIONS.delete, "Playlist ID");
    await transport.request<void>({
      path: `/playlists/${playlistPathId}`,
      operation: OPERATIONS.delete,
      options: { method: "DELETE" },
    });
    cache.invalidate("playlists");
  };
}

/**
 * Creates the Plex implementation of the generic playlist capability.
 *
 * The capability owns playlist wire validation, source URI construction,
 * pagination, batching, and cache invalidation. It performs no direct network,
 * configuration, or global-cache access.
 *
 * @param dependencies - Private transport, cache, identity callback, and test seams.
 * @returns A generic playlist capability backed by Plex endpoints.
 */
export function createPlexPlaylistCapability(
  dependencies: PlexPlaylistCapabilityDependencies,
): MediaServerPlaylistCapability {
  const boundDependencies: BoundPlexPlaylistCapabilityDependencies = Object.freeze({
    transport: dependencies.transport,
    cache: dependencies.cache,
    getMachineIdentifier: dependencies.getMachineIdentifier,
    pageSize: validatePageSize(dependencies.pageSize ?? DEFAULT_PAGE_SIZE),
    warn: dependencies.warn ?? logWarn,
    now: dependencies.now ?? Date.now,
  });
  const list = createPlaylistList(boundDependencies);

  return Object.freeze({
    list,
    byName: createPlaylistByName(list),
    tracks: createPlaylistTrackReader(boundDependencies),
    create: createPlaylistCreator(boundDependencies),
    addTracks: createPlaylistTrackAdder(boundDependencies),
    delete: createPlaylistDeleter(boundDependencies),
  });
}
