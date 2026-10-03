/**
 * Album selection component for interactive multi-select UI.
 *
 * Provides album-level selection with:
 * - Type-ahead filtering on album name
 * - Rating display (stars or numeric)
 * - Track count display
 * - Source path context in header
 *
 * @module rfmedia-cli/lib/interactive/AlbumSelector
 */

import React from "react";

import type { AlbumDisplayInfo } from "../../types/interactive.js";
import { BaseSelector, type BaseDisplayInfo } from "./BaseSelector.js";

/**
 * Maximum recommended items for the selection list.
 * Displays a warning when album count exceeds this threshold.
 */
const MAX_RECOMMENDED_ITEMS = 50;

/**
 * Format a rating value (0.0-1.0) for display.
 *
 * Converts the normalized rating to a stars display format.
 * Ratings are typically stored as 0.0-1.0 and displayed as 1-5 stars.
 *
 * @param rating - Normalized rating value (0.0-1.0)
 * @returns Formatted string like "4.5" for star display
 */
function getRatingDisplay(rating: number): string {
  // Convert 0.0-1.0 to 1-5 scale (multiply by 5)
  const stars = rating * 5;
  // Display with one decimal place
  return stars.toFixed(1);
}

/**
 * Create a display label for an album.
 *
 * Format with rating: `{albumName} [{rating}★] ({trackCount} tracks)`
 * Format without rating: `{albumName} ({trackCount} tracks)`
 *
 * @param album - Album display info
 * @returns Formatted label string
 */
function createAlbumLabel(album: AlbumDisplayInfo): string {
  const trackText =
    album.trackCount === 1 ? `${album.trackCount} track` : `${album.trackCount} tracks`;

  if (album.rating !== undefined && album.rating > 0) {
    const ratingDisplay = getRatingDisplay(album.rating);
    return `${album.albumName} [${ratingDisplay}★] (${trackText})`;
  }

  return `${album.albumName} (${trackText})`;
}

/**
 * Props for the AlbumSelector component.
 */
export interface AlbumSelectorProps {
  /** Albums available for selection */
  readonly albums: readonly AlbumDisplayInfo[];
  /** Source path for context display in header */
  readonly sourcePath: string;
  /** Number of visible options in the menu */
  readonly pageSize: number;
  /** Callback when selection is confirmed with selected album paths */
  readonly onSelect: (selected: readonly string[]) => void;
  /** Callback when selection is cancelled */
  readonly onCancel: () => void;
}

/**
 * Extended display info for BaseSelector compatibility.
 * Extends BaseDisplayInfo with the value field mapped from path.
 */
interface AlbumSelectItem extends BaseDisplayInfo {
  readonly albumName: string;
}

/**
 * Album selection component using ink-based multi-select.
 *
 * Features:
 * - Type-ahead filtering on album name
 * - Rating display using stars notation
 * - Track count display
 * - Source path context in header
 * - Warning for large album counts (> 50)
 *
 * @example
 * ```tsx
 * <AlbumSelector
 *   albums={albumList}
 *   sourcePath="/music/Artist"
 *   pageSize={20}
 *   onSelect={(paths) => console.log('Selected:', paths)}
 *   onCancel={() => console.log('Cancelled')}
 * />
 * ```
 */
export function AlbumSelector({
  albums,
  sourcePath,
  pageSize,
  onSelect,
  onCancel,
}: AlbumSelectorProps): React.ReactElement {
  // Transform albums to BaseSelector compatible format
  const items: readonly AlbumSelectItem[] = albums.map((album) => ({
    value: album.path,
    label: createAlbumLabel(album),
    albumName: album.albumName,
  }));

  // Custom filter function that matches on album name
  const filterFn = (item: AlbumSelectItem, filter: string): boolean => {
    return item.albumName.toLowerCase().includes(filter.toLowerCase());
  };

  // Generate warning message for large album lists
  const warningMessage =
    albums.length > MAX_RECOMMENDED_ITEMS
      ? `Warning: ${albums.length} albums found. Large lists may be slow to navigate.`
      : undefined;

  // Build header with source path context
  const header = `Select albums from ${sourcePath}`;

  return (
    <BaseSelector
      items={items}
      pageSize={pageSize}
      header={header}
      onSelect={onSelect}
      onCancel={onCancel}
      filterFn={filterFn}
      warningMessage={warningMessage}
    />
  );
}
