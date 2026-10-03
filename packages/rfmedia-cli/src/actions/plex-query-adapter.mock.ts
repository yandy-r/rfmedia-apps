import type {
  MediaAlbum,
  MediaArtist,
  MediaPage,
  MediaServerAdapter,
  MediaTrack,
} from "../types/media-server.js";
import { createMediaServerAdapterMock } from "./test-helpers/media-server-adapter-mocks.js";
import { DEFAULT_MEDIA_SERVER_FEATURES } from "./test-helpers/media-server-fixtures.js";

export interface PlexQueryAdapterMockOptions {
  readonly tracksPage?: MediaPage<MediaTrack>;
  readonly albumsPage?: MediaPage<MediaAlbum>;
  readonly artistsPage?: MediaPage<MediaArtist>;
}

export interface PlexQueryAdapterMock {
  readonly adapter: MediaServerAdapter;
  readonly queryTracks: ReturnType<typeof createMediaServerAdapterMock>["query"]["tracks"];
  readonly queryAlbums: ReturnType<typeof createMediaServerAdapterMock>["query"]["albums"];
  readonly queryArtists: ReturnType<typeof createMediaServerAdapterMock>["query"]["artists"];
}

export function createPlexQueryAdapterMock(
  options: PlexQueryAdapterMockOptions = {},
): PlexQueryAdapterMock {
  const tracksPage = options.tracksPage;
  const albumsPage = options.albumsPage;
  const artistsPage = options.artistsPage;
  const adapterMock = createMediaServerAdapterMock({
    features: {
      ...DEFAULT_MEDIA_SERVER_FEATURES,
      filterPushdown: {
        supported: true,
        fields: [
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
        ],
        operators: [">=", "<=", "==", "!=", "contains", "not_contains"],
      },
    },
    query: {
      ...(tracksPage === undefined ? {} : { tracks: () => Promise.resolve(tracksPage) }),
      ...(albumsPage === undefined ? {} : { albums: () => Promise.resolve(albumsPage) }),
      ...(artistsPage === undefined ? {} : { artists: () => Promise.resolve(artistsPage) }),
    },
  });

  return {
    adapter: adapterMock.adapter,
    queryTracks: adapterMock.query.tracks,
    queryAlbums: adapterMock.query.albums,
    queryArtists: adapterMock.query.artists,
  };
}
