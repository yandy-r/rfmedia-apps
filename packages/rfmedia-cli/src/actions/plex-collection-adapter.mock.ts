import type { MediaServerAdapter, MediaServerFeatures } from "../types/media-server.js";
import { createMediaServerAdapterMock } from "./test-helpers/media-server-adapter-mocks.js";

const COLLECTION_TEST_FEATURES: MediaServerFeatures = {
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
  sonicAnalysis: "server-dependent",
};

export interface PlexCollectionAdapterMock {
  adapter: MediaServerAdapter;
  queryTracks: ReturnType<typeof createMediaServerAdapterMock>["query"]["tracks"];
  queryAlbums: ReturnType<typeof createMediaServerAdapterMock>["query"]["albums"];
  queryArtists: ReturnType<typeof createMediaServerAdapterMock>["query"]["artists"];
  queryAlbumTracks: ReturnType<typeof createMediaServerAdapterMock>["query"]["albumTracks"];
  findLibraryByName: ReturnType<typeof createMediaServerAdapterMock>["library"]["byName"];
  listCollections: ReturnType<typeof createMediaServerAdapterMock>["collection"]["list"];
  getCollection: ReturnType<typeof createMediaServerAdapterMock>["collection"]["get"];
  findCollectionByName: ReturnType<typeof createMediaServerAdapterMock>["collection"]["byName"];
  createCollection: ReturnType<typeof createMediaServerAdapterMock>["collection"]["create"];
  addCollectionItems: ReturnType<typeof createMediaServerAdapterMock>["collection"]["addItems"];
  deleteCollection: ReturnType<typeof createMediaServerAdapterMock>["collection"]["delete"];
}

export function createPlexCollectionAdapterMock(): PlexCollectionAdapterMock {
  const adapterMock = createMediaServerAdapterMock({ features: COLLECTION_TEST_FEATURES });
  return {
    adapter: adapterMock.adapter,
    queryTracks: adapterMock.query.tracks,
    queryAlbums: adapterMock.query.albums,
    queryArtists: adapterMock.query.artists,
    queryAlbumTracks: adapterMock.query.albumTracks,
    findLibraryByName: adapterMock.library.byName,
    listCollections: adapterMock.collection.list,
    getCollection: adapterMock.collection.get,
    findCollectionByName: adapterMock.collection.byName,
    createCollection: adapterMock.collection.create,
    addCollectionItems: adapterMock.collection.addItems,
    deleteCollection: adapterMock.collection.delete,
  };
}
