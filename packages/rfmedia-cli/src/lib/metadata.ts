/**
 * Extended metadata reading utilities for smart filters.
 *
 * This module provides functions to read extended metadata from audio files
 * in a single parseFile() call, supporting genre, year, BPM, and artist filtering.
 *
 * The readExtendedMetadata() function is the primary entry point, combining:
 * - Rating extraction (reusing logic from ratings.ts)
 * - Format metadata (duration, bitrate, codec)
 * - Common tags (genre, year, bpm, artist, artists, album, albumartist)
 */

import { parseFile } from "music-metadata";
import type { IFormat } from "music-metadata";
import type { NormalizedRating, RatingFilter } from "../types/index.js";
import { logDebug, logWarn } from "./logger.js";
import { extractNormalizedRating } from "./ratings.js";

/**
 * Extended metadata result combining rating, format, and common tag data.
 *
 * This interface enables single-pass metadata extraction for smart filter evaluation.
 * All fields except rating and format are optional since not all files have all metadata.
 */
export interface ExtendedMetadata {
  /** Normalized rating (0.0-1.0) or null if unrated */
  rating: NormalizedRating | null;
  /** Audio format/encoding information */
  format: IFormat;
  /** Common music tags for filtering */
  common: {
    /** Track title */
    title?: string;
    /** Genre tags (multiple genres possible) */
    genre?: string[];
    /** Release year */
    year?: number;
    /** Beats per minute */
    bpm?: number;
    /** Primary artist */
    artist?: string;
    /** All artists/contributors */
    artists?: string[];
    /** Album title */
    album?: string;
    /** Album artist (for compilations) */
    albumartist?: string;
  };
}

/**
 * File metadata evidence used by three-plane reconciliation.
 *
 * Missing tags remain null so callers can distinguish absent values from an
 * unsuccessful read. Only fields approved for reconciliation are projected.
 */
export interface ReconciliationMetadata {
  /** Normalized rating (0.0-1.0), or null when the file is unrated */
  readonly rating: number | null;
  /** Primary artist, or null when the tag is absent */
  readonly artist: string | null;
  /** First genre, or null when no genre is present */
  readonly genre: string | null;
  /** Release year, or null when the tag is absent */
  readonly year: number | null;
}

/** Strict result for a reconciliation metadata read. */
export type ReconciliationMetadataReadResult =
  | {
      readonly ok: true;
      readonly metadata: ReconciliationMetadata;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "read-failed";
      };
    };

/**
 * Read extended metadata from an audio file in a single parseFile() call.
 *
 * This function combines rating, format, and common tag extraction for
 * efficient smart filter evaluation. It maintains the skipCovers: true
 * optimization for performance.
 *
 * @param filePath - Absolute path to the audio file
 * @returns Extended metadata or null if file cannot be parsed
 *
 * @example
 * const metadata = await readExtendedMetadata('/path/to/track.mp3');
 * if (metadata) {
 *   console.log(`Rating: ${metadata.rating?.value}`);
 *   console.log(`Genre: ${metadata.common.genre?.join(', ')}`);
 *   console.log(`Year: ${metadata.common.year}`);
 *   console.log(`BPM: ${metadata.common.bpm}`);
 * }
 */
export async function readExtendedMetadata(filePath: string): Promise<ExtendedMetadata | null> {
  try {
    // Single parseFile() call - critical for performance
    const metadata = await parseFile(filePath, { skipCovers: true });

    // Extract rating using the same native-first logic as the direct rating readers
    const rating = extractNormalizedRating(metadata, filePath);
    const extension = filePath.toLowerCase().split(".").pop();
    if (rating === null && (extension === "m4a" || extension === "aac")) {
      const message = "M4A rating: iTunes stores ratings in database, not file metadata.";
      logDebug(`${message} File: ${filePath}`);
    }

    // Extract common tags of interest
    // Prefer common.year over parsing common.date string
    const common: ExtendedMetadata["common"] = {
      title: metadata.common.title,
      genre: metadata.common.genre,
      year: metadata.common.year,
      bpm: metadata.common.bpm,
      artist: metadata.common.artist,
      artists: metadata.common.artists,
      album: metadata.common.album,
      albumartist: metadata.common.albumartist,
    };

    return {
      rating,
      format: metadata.format,
      common,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn(`Failed to read extended metadata from ${filePath}: ${message}`);
    return null;
  }
}

/**
 * Read the metadata fields approved for three-plane reconciliation.
 *
 * Unlike readExtendedMetadata(), this API does not collapse a failed read into
 * the same shape as successfully parsed metadata with missing tags.
 *
 * @param filePath - Absolute path to the audio file
 * @returns Typed read evidence for reconciliation
 */
export async function readReconciliationMetadata(
  filePath: string,
): Promise<ReconciliationMetadataReadResult> {
  const metadata = await readExtendedMetadata(filePath);
  if (metadata === null) {
    return {
      ok: false,
      error: { code: "read-failed" },
    };
  }

  return {
    ok: true,
    metadata: {
      rating: metadata.rating?.value ?? null,
      artist: metadata.common.artist ?? null,
      genre: metadata.common.genre?.[0] ?? null,
      year: metadata.common.year ?? null,
    },
  };
}

/**
 * Check if a filter uses smart filter functionality requiring extended metadata.
 *
 * This function determines if the filter needs extended metadata (genre, year,
 * BPM, artist) beyond basic rating and format metadata. When true, the caller
 * should use readExtendedMetadata() instead of readRatingAndFormat().
 *
 * Extends the existing hasMetadataFilters() pattern from ratings.ts.
 *
 * @param filter - Rating filter configuration
 * @returns true if filter has smartFilter defined requiring extended metadata
 *
 * @example
 * if (hasExtendedFilters(filter)) {
 *   const metadata = await readExtendedMetadata(filePath);
 *   // Evaluate smart filter rules against extended metadata
 * } else {
 *   const result = await readRatingAndFormat(filePath);
 *   // Use basic rating/format checks
 * }
 */
export function hasExtendedFilters(filter: RatingFilter): boolean {
  // Check if smartFilter is defined on the filter
  // The smartFilter field indicates nested boolean logic with extended metadata fields
  return "smartFilter" in filter && filter.smartFilter !== undefined;
}
