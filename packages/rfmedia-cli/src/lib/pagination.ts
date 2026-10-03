import type { MediaItem, MediaPage } from "../types/media-server.js";

/** Response metadata required to advance offset-based pagination safely. */
export type PaginationPageMetadata = Pick<MediaPage<MediaItem>, "offset" | "returned" | "hasMore">;

/**
 * Advances to the next server offset using the pre-residual item count.
 *
 * @param page - Metadata returned for the current server page
 * @param queryTarget - Human-readable query target used in failure messages
 * @returns The current offset when pagination is complete, otherwise the next offset
 * @throws Error when the server reports another page without returning any items
 */
export function advancePaginationOffset(page: PaginationPageMetadata, queryTarget: string): number {
  if (!page.hasMore) {
    return page.offset;
  }

  if (page.returned <= 0) {
    throw new Error(
      `Pagination stalled while querying ${queryTarget}: server reported more results but returned an empty page`,
    );
  }

  return page.offset + page.returned;
}
