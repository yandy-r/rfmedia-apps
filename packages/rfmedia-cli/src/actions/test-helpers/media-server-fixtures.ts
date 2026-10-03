import type {
  MediaAlbum,
  MediaArtist,
  MediaCollection,
  MediaPage,
  MediaPlaylist,
  MediaServerFeatures,
  MediaServerLibrary,
  MediaTrack,
} from "../../types/media-server.js";

export const EMPTY_TRACK_PAGE: MediaPage<MediaTrack> = {
  items: [],
  total: 0,
  offset: 0,
  returned: 0,
  hasMore: false,
};

export const EMPTY_ALBUM_PAGE: MediaPage<MediaAlbum> = {
  items: [],
  total: 0,
  offset: 0,
  returned: 0,
  hasMore: false,
};

export const EMPTY_ARTIST_PAGE: MediaPage<MediaArtist> = {
  items: [],
  total: 0,
  offset: 0,
  returned: 0,
  hasMore: false,
};

export const DEFAULT_MEDIA_SERVER_FEATURES: MediaServerFeatures = {
  ratings: {
    readable: true,
    writable: true,
    normalized: true,
    nativeScale: { min: 0, max: 10, step: 1 },
  },
  smartPlaylists: true,
  smartCollections: true,
  pathScopedScans: true,
  filterPushdown: {
    supported: true,
    fields: [],
    operators: [],
  },
  sonicAnalysis: "server-dependent",
};

export function createMediaTrackFixture(overrides: Partial<MediaTrack> = {}): MediaTrack {
  return {
    id: "track-1",
    kind: "track",
    title: "Track 1",
    artist: "Artist 1",
    album: "Album 1",
    rating: 0.8,
    playCount: 10,
    durationMs: 180_000,
    filePath: "/music/Artist 1/Album 1/track1.flac",
    ...overrides,
  };
}

export function createMediaAlbumFixture(overrides: Partial<MediaAlbum> = {}): MediaAlbum {
  return {
    id: "album-1",
    kind: "album",
    title: "Album 1",
    artist: "Artist 1",
    rating: null,
    trackCount: 1,
    ...overrides,
  };
}

export function createMediaArtistFixture(overrides: Partial<MediaArtist> = {}): MediaArtist {
  return {
    id: "artist-1",
    kind: "artist",
    title: "Artist 1",
    rating: null,
    albumCount: 1,
    ...overrides,
  };
}

export function createMediaLibraryFixture(
  overrides: Partial<MediaServerLibrary> = {},
): MediaServerLibrary {
  return {
    id: "library-1",
    title: "Music",
    kind: "track",
    ...overrides,
  };
}

export function createMediaPlaylistFixture(overrides: Partial<MediaPlaylist> = {}): MediaPlaylist {
  return {
    id: "playlist-1",
    title: "Playlist 1",
    smart: false,
    itemCount: 1,
    durationMs: 180_000,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    ...overrides,
  };
}

export function createMediaCollectionFixture(
  overrides: Partial<MediaCollection> = {},
): MediaCollection {
  return {
    id: "collection-1",
    title: "Collection 1",
    kind: "track",
    itemCount: 1,
    smart: false,
    ...overrides,
  };
}
