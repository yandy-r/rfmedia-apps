import type { MediaServerAdapter } from "../types/media-server.js";
import { createMediaServerAdapterMock } from "./test-helpers/media-server-adapter-mocks.js";

export interface PlexCopyAdapterMock {
  readonly adapter: MediaServerAdapter;
  readonly scan: ReturnType<typeof createMediaServerAdapterMock>["scan"];
}

export function createPlexCopyAdapterMock(): PlexCopyAdapterMock {
  const adapterMock = createMediaServerAdapterMock();

  return {
    adapter: adapterMock.adapter,
    scan: adapterMock.scan,
  };
}
