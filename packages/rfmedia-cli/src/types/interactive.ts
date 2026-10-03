/**
 * Types for interactive selection feature.
 *
 * Provides type definitions for the ink-based interactive multi-select menus
 * used in copy and delete commands. These types support the hierarchical
 * selection flow: sources -> refine -> albums/tracks.
 */

/**
 * Source/artist display information for interactive selection UI.
 *
 * Contains data needed to render a source in the multi-select menu,
 * including counts for albums and tracks within the source.
 */
export interface SourceDisplayInfo {
  /** Absolute path to the source directory */
  readonly path: string;
  /** Formatted label for display (typically artist name with counts) */
  readonly label: string;
  /** Number of albums in this source */
  readonly albumCount: number;
  /** Total number of tracks across all albums */
  readonly trackCount: number;
}

/**
 * Album display information for interactive selection UI.
 *
 * Contains data needed to render an album in the multi-select menu,
 * including optional rating information for filter mode.
 */
export interface AlbumDisplayInfo {
  /** Absolute path to the album directory */
  readonly path: string;
  /** Formatted label for display */
  readonly label: string;
  /** Album folder name */
  readonly albumName: string;
  /** Parent artist name */
  readonly artistName: string;
  /** Average or representative album rating (0.0-1.0 scale, optional) */
  readonly rating?: number;
  /** Number of tracks in the album */
  readonly trackCount: number;
}

/**
 * Track display information for interactive selection UI.
 *
 * Contains data needed to render a track in the multi-select menu,
 * with album context for grouping display.
 */
export interface TrackDisplayInfo {
  /** Absolute path to the track file */
  readonly path: string;
  /** Formatted label for display */
  readonly label: string;
  /** Track title or filename */
  readonly trackName: string;
  /** Parent album name (used for grouping) */
  readonly albumName: string;
  /** Artist name */
  readonly artistName: string;
  /** Track number within album (optional) */
  readonly trackNumber?: number;
}

/**
 * Delete item display information for interactive selection UI.
 *
 * Contains data needed to render a suffixed copy in the delete
 * multi-select menu, grouped by artist.
 */
export interface DeleteDisplayInfo {
  /** Absolute path to the suffixed copy directory */
  readonly path: string;
  /** Formatted label for display */
  readonly label: string;
  /** Suffix portion of the path (e.g., "Album-001") */
  readonly suffix: string;
  /** Parent artist name (used for grouping) */
  readonly artistName: string;
}

/**
 * Options for interactive selection components.
 *
 * Configures pagination and cancellation for the multi-select interface.
 */
export interface InteractiveSelectionOptions {
  /** Number of visible options in the selection menu */
  readonly pageSize: number;
  /** Optional abort signal for cancellation support */
  readonly signal?: AbortSignal;
}
