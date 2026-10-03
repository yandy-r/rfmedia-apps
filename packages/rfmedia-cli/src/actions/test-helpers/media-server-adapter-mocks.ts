import { vi, type Mock } from "vitest";

import type {
  MediaServerAdapter,
  MediaServerCapabilities,
  MediaServerCollectionCapability,
  MediaServerFeatures,
  MediaServerIdentityCapability,
  MediaServerLibraryCapability,
  MediaServerMetadataCapability,
  MediaServerPlaylistCapability,
  MediaServerQueryCapability,
  MediaServerScanCapability,
  MediaServerType,
} from "../../types/media-server.js";
import {
  DEFAULT_MEDIA_SERVER_FEATURES,
  EMPTY_ALBUM_PAGE,
  EMPTY_ARTIST_PAGE,
  EMPTY_TRACK_PAGE,
} from "./media-server-fixtures.js";

type MockedCapability<T> = {
  [K in keyof T]: T[K] extends (...args: infer TArgs) => infer TResult
    ? Mock<(...args: TArgs) => TResult>
    : never;
};

export interface MediaServerAdapterMockOptions {
  type?: MediaServerType;
  capabilities?: Partial<MediaServerCapabilities>;
  features?: MediaServerFeatures;
  query?: Partial<MediaServerQueryCapability>;
  library?: Partial<MediaServerLibraryCapability>;
  scan?: Partial<MediaServerScanCapability>;
  playlist?: Partial<MediaServerPlaylistCapability>;
  collection?: Partial<MediaServerCollectionCapability>;
  metadata?: Partial<MediaServerMetadataCapability>;
  /** Opt in to the optional provider-neutral identity capability. */
  identity?: Partial<MediaServerIdentityCapability>;
}

export interface MediaServerAdapterMock {
  adapter: MediaServerAdapter;
  query: MockedCapability<MediaServerQueryCapability>;
  library: MockedCapability<MediaServerLibraryCapability>;
  scan: MockedCapability<MediaServerScanCapability>;
  playlist: MockedCapability<MediaServerPlaylistCapability>;
  collection: MockedCapability<MediaServerCollectionCapability>;
  metadata: MockedCapability<MediaServerMetadataCapability>;
  identity?: MockedCapability<MediaServerIdentityCapability>;
}

export function createMediaServerAdapterMock(
  options: MediaServerAdapterMockOptions = {},
): MediaServerAdapterMock {
  const query: MockedCapability<MediaServerQueryCapability> = {
    libraryContentVersion: vi.fn(
      options.query?.libraryContentVersion ??
        (() =>
          Promise.resolve({
            libraryId: "mock-library",
            value: "mock-content-version",
          })),
    ),
    trackById: vi.fn(
      options.query?.trackById ??
        ((trackId: string) => Promise.reject(new Error(`Track not found: ${trackId}`))),
    ),
    tracks: vi.fn(options.query?.tracks ?? (() => Promise.resolve(EMPTY_TRACK_PAGE))),
    albums: vi.fn(options.query?.albums ?? (() => Promise.resolve(EMPTY_ALBUM_PAGE))),
    artists: vi.fn(options.query?.artists ?? (() => Promise.resolve(EMPTY_ARTIST_PAGE))),
    albumTracks: vi.fn(options.query?.albumTracks ?? (() => Promise.resolve([]))),
  };
  const library: MockedCapability<MediaServerLibraryCapability> = {
    list: vi.fn(options.library?.list ?? (() => Promise.resolve([]))),
    byName: vi.fn(
      options.library?.byName ??
        ((name: string) => Promise.reject(new Error(`Library not found: ${name}`))),
    ),
  };
  const scan: MockedCapability<MediaServerScanCapability> = {
    trigger: vi.fn(
      options.scan?.trigger ?? (() => Promise.resolve({ success: true, message: "scan queued" })),
    ),
    triggerPath: vi.fn(
      options.scan?.triggerPath ??
        (() => Promise.resolve({ success: true, message: "path scan queued" })),
    ),
    triggerSource: vi.fn(
      options.scan?.triggerSource ??
        (() => Promise.resolve({ success: true, message: "source scan queued" })),
    ),
  };
  const playlist: MockedCapability<MediaServerPlaylistCapability> = {
    list: vi.fn(options.playlist?.list ?? (() => Promise.resolve([]))),
    byName: vi.fn(
      options.playlist?.byName ??
        ((name: string) => Promise.reject(new Error(`Playlist not found: ${name}`))),
    ),
    delete: vi.fn(options.playlist?.delete ?? (() => Promise.resolve())),
    tracks: vi.fn(options.playlist?.tracks ?? (() => Promise.resolve([]))),
    create: vi.fn(
      options.playlist?.create ??
        ((name: string) => Promise.reject(new Error(`Playlist creation not configured: ${name}`))),
    ),
    addTracks: vi.fn(options.playlist?.addTracks ?? (() => Promise.resolve())),
  };
  const collection: MockedCapability<MediaServerCollectionCapability> = {
    list: vi.fn(options.collection?.list ?? (() => Promise.resolve([]))),
    get: vi.fn(
      options.collection?.get ??
        ((id: string) => Promise.reject(new Error(`Collection not found: ${id}`))),
    ),
    byName: vi.fn(
      options.collection?.byName ??
        ((_libraryId: string, name: string) =>
          Promise.reject(new Error(`Collection not found: ${name}`))),
    ),
    items: vi.fn(options.collection?.items ?? (() => Promise.resolve([]))),
    create: vi.fn(
      options.collection?.create ??
        ((_libraryId, input) =>
          Promise.reject(new Error(`Collection creation not configured: ${input.title}`))),
    ),
    addItems: vi.fn(options.collection?.addItems ?? (() => Promise.resolve())),
    delete: vi.fn(options.collection?.delete ?? (() => Promise.resolve())),
  };
  const metadata: MockedCapability<MediaServerMetadataCapability> = {
    updateTrackRating: vi.fn(
      options.metadata?.updateTrackRating ??
        (() => Promise.resolve({ success: true, message: "rating updated" })),
    ),
  };
  const identity: MockedCapability<MediaServerIdentityCapability> | undefined =
    options.identity === undefined
      ? undefined
      : {
          getInstanceId: vi.fn(
            options.identity.getInstanceId ?? (() => Promise.resolve("test-media-server-instance")),
          ),
          listArtists: vi.fn(
            options.identity.listArtists ??
              ((identityOptions) =>
                Promise.resolve(
                  Object.freeze({
                    libraryId: identityOptions.library,
                    items: Object.freeze([]),
                    total: 0,
                    offset: identityOptions.offset ?? 0,
                    returned: 0,
                    hasMore: false,
                  }),
                )),
          ),
        };

  const capabilities: MediaServerCapabilities = {
    query: true,
    library: true,
    scan: true,
    playlist: true,
    collection: true,
    metadata: true,
    ...options.capabilities,
  };
  const features = options.features ?? DEFAULT_MEDIA_SERVER_FEATURES;

  const adapter: MediaServerAdapter = {
    type: options.type ?? "plex",
    capabilities,
    features,
    query,
    library,
    scan,
    playlist,
    collection,
    metadata,
    ...(identity === undefined ? {} : { identity }),
  };

  return {
    adapter,
    query,
    library,
    scan,
    playlist,
    collection,
    metadata,
    ...(identity === undefined ? {} : { identity }),
  };
}
