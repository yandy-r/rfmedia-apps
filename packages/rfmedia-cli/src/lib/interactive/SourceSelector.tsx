/**
 * Source selector component for interactive artist/source multi-select.
 *
 * Provides a multi-select interface for choosing source paths with
 * display information including album and track counts.
 *
 * @module rfmedia-cli/lib/interactive/SourceSelector
 */

import React from "react";

import type { SourceDisplayInfo } from "../../types/interactive.js";
import { BaseSelector, type BaseDisplayInfo } from "./BaseSelector.js";

/**
 * Props for the SourceSelector component.
 */
export interface SourceSelectorProps {
  /** Sources to display in the multi-select */
  readonly sources: readonly SourceDisplayInfo[];
  /** Number of visible options in the menu */
  readonly pageSize: number;
  /** Callback when selection is confirmed with array of selected paths */
  readonly onSelect: (selected: readonly string[]) => void;
  /** Callback when selection is cancelled */
  readonly onCancel: () => void;
}

/**
 * Filter function for source items.
 *
 * Matches against both the path and label (artist name with counts).
 * This allows users to filter by typing partial artist names or path segments.
 */
function filterSource(item: BaseDisplayInfo, filter: string): boolean {
  const lowerFilter = filter.toLowerCase();
  // Match against label (artist name with counts) or path
  return (
    item.label.toLowerCase().includes(lowerFilter) || item.value.toLowerCase().includes(lowerFilter)
  );
}

/**
 * Interactive source/artist multi-select component.
 *
 * Features:
 * - Type-ahead filtering on source path and label
 * - Display format: "{artistName} ({albumCount} albums, {trackCount} tracks)"
 * - Selection count in header
 * - MultiSelect with configurable visible option count
 *
 * @example
 * ```tsx
 * <SourceSelector
 *   sources={sourceDisplayInfos}
 *   pageSize={20}
 *   onSelect={(paths) => console.log('Selected:', paths)}
 *   onCancel={() => console.log('Cancelled')}
 * />
 * ```
 */
export function SourceSelector({
  sources,
  pageSize,
  onSelect,
  onCancel,
}: SourceSelectorProps): React.ReactElement {
  // Convert SourceDisplayInfo to BaseDisplayInfo format
  // The label field should already contain the formatted display string:
  // "{artistName} ({albumCount} albums, {trackCount} tracks)"
  const items: readonly BaseDisplayInfo[] = sources.map((source) => ({
    value: source.path,
    label: source.label,
  }));

  return (
    <BaseSelector
      items={items}
      pageSize={pageSize}
      header="Select sources"
      onSelect={onSelect}
      onCancel={onCancel}
      filterFn={filterSource}
    />
  );
}
