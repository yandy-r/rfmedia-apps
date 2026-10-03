import {
  MediaServerError,
  type MediaServerMetadataCapability,
  type MediaServerRatingUpdateResult,
  type NormalizedMediaRating,
} from "../../../types/media-server.js";
import type { PlexResponseCache } from "./cache.js";
import type { PlexTransport } from "./client.js";
import { normalizedRatingToPlexNative } from "./mappers.js";

const UPDATE_TRACK_RATING_OPERATION = "update Plex track rating";
const PLEX_LIBRARY_IDENTIFIER = "com.plexapp.plugins.library";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

function validateTrackId(trackId: string): string {
  if (trackId.length === 0 || CONTROL_CHARACTERS.test(trackId)) {
    throw new TypeError("Track ID must be a non-empty opaque ID");
  }
  return trackId;
}

function failureMessage(error: unknown): string {
  if (
    error instanceof MediaServerError &&
    error.code === "authentication" &&
    error.statusCode === 401
  ) {
    return "Authentication failed (401) - check your plex token";
  }
  return error instanceof Error ? error.message : String(error);
}

function failureResult(error: unknown): MediaServerRatingUpdateResult {
  const statusCode = error instanceof MediaServerError ? error.statusCode : undefined;
  return {
    success: false,
    message: failureMessage(error),
    ...(statusCode === undefined ? {} : { statusCode }),
  };
}

/**
 * Creates the private Plex implementation of normalized metadata updates.
 *
 * The capability validates generic input before making one non-replayable PUT
 * request. Only cached query results contain entity ratings today, so that
 * category is invalidated after confirmed success and never on failure.
 *
 * @param transport - Sole authenticated Plex request primitive.
 * @param cache - Adapter-local response cache containing rating-bearing queries.
 * @returns The generic, non-throwing metadata capability backed by Plex.
 */
export function createPlexMetadataCapability(
  transport: PlexTransport,
  cache: PlexResponseCache,
): MediaServerMetadataCapability {
  return Object.freeze({
    async updateTrackRating(
      trackId: string,
      rating: NormalizedMediaRating | null,
    ): Promise<MediaServerRatingUpdateResult> {
      try {
        const key = validateTrackId(trackId);
        const plexRating = normalizedRatingToPlexNative(rating);

        await transport.request<void>({
          path: "/:/rate",
          operation: UPDATE_TRACK_RATING_OPERATION,
          options: {
            method: "PUT",
            query: {
              identifier: PLEX_LIBRARY_IDENTIFIER,
              key,
              rating: plexRating,
            },
          },
        });

        cache.invalidate("queries");
        return { success: true, message: "Rating updated" };
      } catch (error: unknown) {
        return failureResult(error);
      }
    },
  });
}
