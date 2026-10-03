import {
  MEDIA_IDENTITY_MAX_ID_BYTES,
  MEDIA_IDENTITY_MAX_PAGE_SIZE,
  MediaServerError,
  type MediaArtistExternalIdentity,
  type MediaArtistIdentity,
  type MediaIdentityPage,
  type MediaServerIdentityCapability,
  type MediaServerLibrary,
} from "../../../types/media-server.js";
import { advancePaginationOffset } from "../../pagination.js";
import type { PlexTransport } from "./client.js";
import {
  PLEX_METADATA_TYPE_CODES,
  isPlexWireArtistIdentityResponse,
  type PlexWireArtistIdentity,
} from "./types.js";

const DEFAULT_PAGE_SIZE = 100;
const MUSICBRAINZ_GUID_PREFIX = "mbid://";
const UNSAFE_IDENTITY_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

/** Dependencies captured by the private Plex identity endpoint family. */
export interface PlexIdentityCapabilityDependencies {
  readonly transport: PlexTransport;
  readonly findLibrary: (
    name: string,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<MediaServerLibrary>;
  readonly getMachineIdentifier: (options?: { readonly signal?: AbortSignal }) => Promise<string>;
  readonly pageSize?: number;
}

function invalidResponse(operation: string, message: string): MediaServerError {
  return new MediaServerError(message, {
    code: "invalid-response",
    serverType: "plex",
    operation,
    retryable: false,
  });
}

function isBoundedOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim().length > 0 &&
    new TextEncoder().encode(value).byteLength <= MEDIA_IDENTITY_MAX_ID_BYTES &&
    !UNSAFE_IDENTITY_TEXT_PATTERN.test(value)
  );
}

function validatePageSize(value: number | undefined): number {
  const resolved = value ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > MEDIA_IDENTITY_MAX_PAGE_SIZE) {
    throw new RangeError(
      `Plex identity page size must be between 1 and ${MEDIA_IDENTITY_MAX_PAGE_SIZE}`,
    );
  }
  return resolved;
}

function requestedOffset(value: number | undefined): number {
  const resolved = value ?? 0;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new RangeError("Plex identity offset must be a non-negative safe integer");
  }
  return resolved;
}

function requestedLimit(value: number | undefined, defaultPageSize: number): number {
  const resolved = value ?? defaultPageSize;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > MEDIA_IDENTITY_MAX_PAGE_SIZE) {
    throw new RangeError(
      `Plex identity limit must be between 1 and ${MEDIA_IDENTITY_MAX_PAGE_SIZE}`,
    );
  }
  return resolved;
}

function projectExternalIds(wire: PlexWireArtistIdentity): readonly MediaArtistExternalIdentity[] {
  const externalIds = (wire.Guid ?? []).flatMap((guid): readonly MediaArtistExternalIdentity[] => {
    if (
      guid.id.slice(0, MUSICBRAINZ_GUID_PREFIX.length).toLowerCase() !== MUSICBRAINZ_GUID_PREFIX
    ) {
      return [];
    }
    return [
      Object.freeze({
        namespace: "musicbrainz",
        kind: "artist",
        value: guid.id.slice(MUSICBRAINZ_GUID_PREFIX.length),
      }),
    ];
  });
  return Object.freeze(externalIds);
}

function projectArtist(wire: PlexWireArtistIdentity): MediaArtistIdentity {
  return Object.freeze({
    id: wire.ratingKey,
    kind: "artist",
    title: wire.title,
    externalIds: projectExternalIds(wire),
  });
}

function projectPage(
  response: unknown,
  libraryId: string,
  requestedStart: number,
): MediaIdentityPage {
  if (!isPlexWireArtistIdentityResponse(response)) {
    throw invalidResponse(
      "list Plex artist identities",
      "Plex returned malformed artist identity metadata",
    );
  }

  const container = response.MediaContainer;
  const wireItems = container.Metadata ?? [];
  const offset = container.offset ?? requestedStart;
  const returned = wireItems.length;
  const end = offset + returned;
  const total = container.totalSize ?? end;
  if (!Number.isSafeInteger(end) || total < end) {
    throw invalidResponse(
      "list Plex artist identities",
      "Plex returned invalid artist identity pagination metadata",
    );
  }

  const page: MediaIdentityPage = Object.freeze({
    libraryId,
    items: Object.freeze(wireItems.map(projectArtist)),
    total,
    offset,
    returned,
    hasMore: end < total,
  });
  const nextOffset = advancePaginationOffset(page, "Plex artist identities");
  if (page.hasMore && nextOffset <= requestedStart) {
    throw invalidResponse(
      "list Plex artist identities",
      "Plex returned invalid artist identity pagination metadata",
    );
  }
  return page;
}

/**
 * Creates the private, provider-neutral Plex artist identity capability.
 */
export function createPlexIdentityCapability(
  dependencies: PlexIdentityCapabilityDependencies,
): MediaServerIdentityCapability {
  const defaultPageSize = validatePageSize(dependencies.pageSize);

  const getInstanceId = async (options?: { readonly signal?: AbortSignal }): Promise<string> => {
    options?.signal?.throwIfAborted();
    const instanceId = await dependencies.getMachineIdentifier({ signal: options?.signal });
    options?.signal?.throwIfAborted();
    if (!isBoundedOpaqueId(instanceId)) {
      throw invalidResponse(
        "fetch Plex server identity",
        "Plex returned an invalid machine identifier",
      );
    }
    return instanceId;
  };

  const listArtists: MediaServerIdentityCapability["listArtists"] = async (options) => {
    options.signal?.throwIfAborted();
    const offset = requestedOffset(options.offset);
    const limit = requestedLimit(options.limit, defaultPageSize);
    if (!Number.isSafeInteger(offset + limit)) {
      throw new RangeError("Plex identity page range exceeds safe integer bounds");
    }

    const library = await dependencies.findLibrary(options.library, { signal: options.signal });
    options.signal?.throwIfAborted();
    if (!isBoundedOpaqueId(library.id)) {
      throw invalidResponse(
        "list Plex artist identities",
        "Plex returned an invalid library identifier",
      );
    }

    const response = await dependencies.transport.request<unknown>({
      path: `/library/sections/${encodeURIComponent(library.id)}/all`,
      operation: "list Plex artist identities",
      options: {
        method: "GET",
        signal: options.signal,
        query: {
          type: PLEX_METADATA_TYPE_CODES.artist,
          includeGuids: 1,
          "X-Plex-Container-Start": offset,
          "X-Plex-Container-Size": limit,
        },
      },
    });
    return projectPage(response, library.id, offset);
  };

  return Object.freeze({ getInstanceId, listArtists });
}
