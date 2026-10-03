import type { MediaServerAdapter } from "../types/media-server.js";
import { createMediaServerAdapterMock } from "./test-helpers/media-server-adapter-mocks.js";

export interface PlexSyncAdapterMock {
  adapter: MediaServerAdapter;
  queryTracks: ReturnType<typeof createMediaServerAdapterMock>["query"]["tracks"];
  updateTrackRating: ReturnType<
    typeof createMediaServerAdapterMock
  >["metadata"]["updateTrackRating"];
}

export function createPlexSyncAdapterMock(): PlexSyncAdapterMock {
  const adapterMock = createMediaServerAdapterMock();
  return {
    adapter: adapterMock.adapter,
    queryTracks: adapterMock.query.tracks,
    updateTrackRating: adapterMock.metadata.updateTrackRating,
  };
}
