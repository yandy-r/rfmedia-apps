import {
  MediaServerError,
  type MediaCollection,
  type MediaItem,
  type MediaServerCollectionCapability,
} from "../../../types/media-server.js";
import type { PlexTransport } from "./client.js";
import type { PlexResponseCache } from "./cache.js";
import {
  mapPlexCollection,
  mapPlexCollectionItem,
  mediaKindToPlexMetadataType,
} from "./mappers.js";
import {
  isPlexWireCollection,
  isPlexWireCollectionItem,
  isPlexWireMetadataResponse,
} from "./types.js";

const DEFAULT_COLLECTION_PAGE_SIZE = 100;
const COLLECTION_ADD_BATCH_SIZE = 50;

/** Loads the Plex machine identifier used only to construct collection source URIs. */
export type PlexMachineIdentifierLoader = () => Promise<string>;

/** Construction options for the private Plex collection endpoint family. */
export interface PlexCollectionCapabilityOptions {
  readonly pageSize?: number;
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function invalidResponse(operation: string, message: string): MediaServerError {
  return new MediaServerError(message, {
    code: "invalid-response",
    serverType: "plex",
    operation,
    retryable: false,
  });
}

function notFound(operation: string, message: string): MediaServerError {
  return new MediaServerError(message, {
    code: "not-found",
    serverType: "plex",
    operation,
    retryable: false,
  });
}

function fallbackFailure(
  operation: string,
  firstItemId: string | undefined,
  cause: unknown,
): MediaServerError {
  return new MediaServerError(
    `Failed to add any items to collection. First item ID: ${firstItemId ?? "unknown"}`,
    {
      code: "request-failed",
      serverType: "plex",
      operation,
      retryable: false,
      cause,
    },
  );
}

function validatePageSize(pageSize: number): number {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new TypeError("Plex collection page size must be a positive safe integer");
  }
  return pageSize;
}

function collectionSourceUri(machineIdentifier: string, itemIds: readonly string[]): string {
  return `server://${machineIdentifier}/com.plexapp.plugins.library/library/metadata/${itemIds.join(",")}`;
}

function collectionListCacheKey(libraryId: string) {
  return {
    category: "collections",
    discriminator: ["list", libraryId],
  } as const;
}

interface CollectionDependencies {
  readonly transport: PlexTransport;
  readonly cache: PlexResponseCache;
  readonly loadMachineIdentifier: PlexMachineIdentifierLoader;
  readonly pageSize: number;
}

function createListCollections(
  dependencies: CollectionDependencies,
): MediaServerCollectionCapability["list"] {
  return async (libraryId) => {
    const operation = "list collections";
    const cacheKey = collectionListCacheKey(libraryId);
    const cached = dependencies.cache.get<readonly MediaCollection[]>(cacheKey);
    if (cached !== undefined) return cached;

    const response = await dependencies.transport.request<unknown>({
      path: `/library/sections/${encodePathSegment(libraryId)}/collections`,
      operation,
    });
    if (!isPlexWireMetadataResponse(response, isPlexWireCollection)) {
      throw invalidResponse(operation, "Plex returned invalid collection list data");
    }

    const collections = (response.MediaContainer.Metadata ?? []).map((collection) =>
      mapPlexCollection(collection),
    );
    dependencies.cache.set(cacheKey, collections);
    return collections;
  };
}

function createGetCollection(transport: PlexTransport): MediaServerCollectionCapability["get"] {
  return async (id) => {
    const operation = "get collection";
    const response = await transport.request<unknown>({
      path: `/library/collections/${encodePathSegment(id)}`,
      operation,
    });
    if (!isPlexWireMetadataResponse(response, isPlexWireCollection)) {
      throw invalidResponse(operation, `Plex returned invalid collection data for ID ${id}`);
    }

    const collection = response.MediaContainer.Metadata?.[0];
    if (collection === undefined) throw notFound(operation, `Collection not found: ${id}`);
    return mapPlexCollection(collection);
  };
}

function createFindCollection(
  list: MediaServerCollectionCapability["list"],
): MediaServerCollectionCapability["byName"] {
  return async (libraryId, name) => {
    const collections = await list(libraryId);
    const normalizedName = name.toLocaleLowerCase();
    const collection = collections.find(
      (candidate) => candidate.title.toLocaleLowerCase() === normalizedName,
    );
    if (collection !== undefined) return collection;

    const available =
      collections.length === 0
        ? "(no collections found)"
        : collections.map(({ title }) => title).join(", ");
    throw notFound(
      "find collection by name",
      `Collection "${name}" not found in library. Available collections: ${available}`,
    );
  };
}

function mapCollectionItems(
  metadata: readonly Parameters<typeof mapPlexCollectionItem>[0][],
  operation: string,
  collectionId: string,
): readonly MediaItem[] {
  try {
    return metadata.map((item) => mapPlexCollectionItem(item));
  } catch {
    throw invalidResponse(
      operation,
      `Plex returned invalid collection item data for ID ${collectionId}`,
    );
  }
}

function createGetCollectionItems(
  dependencies: CollectionDependencies,
): MediaServerCollectionCapability["items"] {
  return async (id) => {
    const operation = "get collection items";
    const allItems: MediaItem[] = [];
    let offset = 0;

    while (true) {
      const response = await dependencies.transport.request<unknown>({
        path: `/library/collections/${encodePathSegment(id)}/children`,
        operation,
        options: {
          query: {
            "X-Plex-Container-Start": offset,
            "X-Plex-Container-Size": dependencies.pageSize,
          },
        },
      });
      if (!isPlexWireMetadataResponse(response, isPlexWireCollectionItem)) {
        throw invalidResponse(operation, `Plex returned invalid collection item data for ID ${id}`);
      }

      const metadata = response.MediaContainer.Metadata ?? [];
      if (metadata.length === 0) break;
      allItems.push(...mapCollectionItems(metadata, operation, id));
      offset += metadata.length;
      if (offset >= (response.MediaContainer.totalSize ?? allItems.length)) break;
    }

    return allItems;
  };
}

function createCollection(
  dependencies: CollectionDependencies,
): MediaServerCollectionCapability["create"] {
  return async (libraryId, input) => {
    const operation = "create collection";
    const response = await dependencies.transport.request<unknown>({
      path: "/library/collections",
      operation,
      options: {
        method: "POST",
        query: {
          type: mediaKindToPlexMetadataType(input.kind),
          title: input.title,
          smart: 0,
          sectionId: libraryId,
        },
      },
    });
    if (!isPlexWireMetadataResponse(response, isPlexWireCollection)) {
      throw invalidResponse(operation, "Plex returned invalid data after creating the collection");
    }

    const created = response.MediaContainer.Metadata?.[0];
    if (created === undefined) {
      throw invalidResponse(operation, "Collection was created but no metadata was returned");
    }
    const collection = mapPlexCollection(created, input.kind);
    dependencies.cache.invalidate("collections");
    return collection;
  };
}

async function putItems(
  transport: PlexTransport,
  collectionId: string,
  machineIdentifier: string,
  itemIds: readonly string[],
): Promise<void> {
  await transport.request<void>({
    path: `/library/collections/${encodePathSegment(collectionId)}/items`,
    operation: "add collection items",
    options: {
      method: "PUT",
      query: { uri: collectionSourceUri(machineIdentifier, itemIds) },
    },
  });
}

async function addOneByOne(
  transport: PlexTransport,
  collectionId: string,
  machineIdentifier: string,
  itemIds: readonly string[],
): Promise<number> {
  let successCount = 0;
  let firstFailure: unknown;
  for (const itemId of itemIds) {
    try {
      await putItems(transport, collectionId, machineIdentifier, [itemId]);
      successCount += 1;
    } catch (error: unknown) {
      firstFailure ??= error;
    }
  }
  if (successCount === 0) {
    throw fallbackFailure("add collection items", itemIds[0], firstFailure);
  }
  return successCount;
}

function createAddCollectionItems(
  dependencies: CollectionDependencies,
): MediaServerCollectionCapability["addItems"] {
  return async (id, itemIds) => {
    if (itemIds.length === 0) return;

    const machineIdentifier = await dependencies.loadMachineIdentifier();
    let confirmedMutation = false;
    try {
      for (let start = 0; start < itemIds.length; start += COLLECTION_ADD_BATCH_SIZE) {
        const batch = itemIds.slice(start, start + COLLECTION_ADD_BATCH_SIZE);
        try {
          await putItems(dependencies.transport, id, machineIdentifier, batch);
          confirmedMutation = true;
        } catch (error: unknown) {
          if (!(error instanceof MediaServerError) || error.statusCode !== 400) throw error;
          confirmedMutation ||=
            (await addOneByOne(dependencies.transport, id, machineIdentifier, batch)) > 0;
        }
      }
    } finally {
      if (confirmedMutation) dependencies.cache.invalidate("collections");
    }
  };
}

function createDeleteCollection(
  dependencies: CollectionDependencies,
): MediaServerCollectionCapability["delete"] {
  return async (id) => {
    await dependencies.transport.request<void>({
      path: `/library/collections/${encodePathSegment(id)}`,
      operation: "delete collection",
      options: { method: "DELETE" },
    });
    dependencies.cache.invalidate("collections");
  };
}

/**
 * Creates the private Plex collection endpoint family.
 *
 * The capability accepts only provider-neutral collection, library, and item IDs. Plex machine
 * identity is injected as a callback so collection mutations do not depend on the query/library
 * endpoint module.
 *
 * @param transport - Sole authenticated Plex request primitive.
 * @param cache - Adapter-local response cache.
 * @param loadMachineIdentifier - Injected machine-identity lookup used for add source URIs.
 * @param options - Optional page-size override captured at construction.
 * @returns The generic media-server collection capability.
 * @throws TypeError when the configured page size is invalid.
 */
export function createPlexCollectionCapability(
  transport: PlexTransport,
  cache: PlexResponseCache,
  loadMachineIdentifier: PlexMachineIdentifierLoader,
  options: PlexCollectionCapabilityOptions = {},
): MediaServerCollectionCapability {
  const dependencies: CollectionDependencies = {
    transport,
    cache,
    loadMachineIdentifier,
    pageSize: validatePageSize(options.pageSize ?? DEFAULT_COLLECTION_PAGE_SIZE),
  };
  const list = createListCollections(dependencies);

  return Object.freeze({
    list,
    get: createGetCollection(transport),
    byName: createFindCollection(list),
    items: createGetCollectionItems(dependencies),
    create: createCollection(dependencies),
    addItems: createAddCollectionItems(dependencies),
    delete: createDeleteCollection(dependencies),
  });
}
