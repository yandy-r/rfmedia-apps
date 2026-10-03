import type { MediaServerAdapter } from "../types/media-server.js";
import { createMediaServerAdapterMock } from "./test-helpers/media-server-adapter-mocks.js";

export interface PlexPlaylistAdapterMock {
  adapter: MediaServerAdapter;
  query: ReturnType<typeof createMediaServerAdapterMock>["query"];
  library: ReturnType<typeof createMediaServerAdapterMock>["library"];
  scan: ReturnType<typeof createMediaServerAdapterMock>["scan"];
  playlist: ReturnType<typeof createMediaServerAdapterMock>["playlist"];
}

export function createPlexPlaylistAdapterMock(): PlexPlaylistAdapterMock {
  const adapterMock = createMediaServerAdapterMock();
  return {
    adapter: adapterMock.adapter,
    query: adapterMock.query,
    library: adapterMock.library,
    scan: adapterMock.scan,
    playlist: adapterMock.playlist,
  };
}
