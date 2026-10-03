/**
 * Track multi-select component for interactive track selection UI.
 *
 * Provides a specialized multi-select for choosing tracks within a source,
 * with album grouping via box-drawing character prefixes since @inkjs/ui
 * MultiSelect does not support Separator elements.
 *
 * @module rfmedia-cli/lib/interactive/TrackSelector
 */

import React, { useState, useMemo } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { MultiSelect, type Option } from "@inkjs/ui";

import type { TrackDisplayInfo } from "../../types/interactive.js";
import { MAX_FILTER_LENGTH } from "./constants.js";

/**
 * Maximum recommended tracks before showing a performance warning.
 */
const MAX_RECOMMENDED_TRACKS = 100;

/**
 * Props for the TrackSelector component.
 */
export interface TrackSelectorProps {
  /** Tracks to display in the multi-select, grouped by album */
  readonly tracks: readonly TrackDisplayInfo[];
  /** Source path for display in header */
  readonly sourcePath: string;
  /** Number of visible options in the menu */
  readonly pageSize: number;
  /** Callback when selection is confirmed */
  readonly onSelect: (selected: readonly string[]) => void;
  /** Callback when selection is cancelled */
  readonly onCancel: () => void;
}

/**
 * Sanitize and validate filter input character.
 *
 * Only allows alphanumeric characters, hyphens, underscores, and dots
 * which are valid in file and folder names.
 *
 * @param char - Single character input from keyboard
 * @returns true if character is valid for filtering
 */
function isValidFilterChar(char: string): boolean {
  return /^[a-zA-Z0-9\-_.]$/.test(char);
}

/**
 * Track option with album grouping prefix for visual separation.
 */
interface GroupedTrackOption {
  /** Display label with box-drawing prefix */
  label: string;
  /** Track path value */
  value: string;
  /** Original track info for filtering */
  track: TrackDisplayInfo;
  /** Whether this is the first track in an album group */
  isFirstInGroup: boolean;
  /** Album name for this track */
  albumName: string;
}

/**
 * Build grouped track options with box-drawing prefixes.
 *
 * Groups tracks by album and adds visual prefixes:
 * - First track in group: "┌ {label} ─ {albumName}"
 * - Subsequent tracks: "│ {label}"
 *
 * Box-drawing characters provide visual grouping:
 * - First track shows album header with the pre-formatted label (includes rating)
 * - Subsequent tracks show indented track info with pre-formatted label
 *
 * Uses track.label (from prepareTracksForDisplay) which includes rating stars
 * when available, rather than track.trackName which is just the filename.
 *
 * @param tracks - Tracks to group
 * @returns Options with grouping prefixes
 */
function buildGroupedOptions(tracks: readonly TrackDisplayInfo[]): GroupedTrackOption[] {
  const options: GroupedTrackOption[] = [];

  // Group tracks by album name
  const albumGroups = new Map<string, TrackDisplayInfo[]>();
  for (const track of tracks) {
    const group = albumGroups.get(track.albumName);
    if (group) {
      group.push(track);
    } else {
      albumGroups.set(track.albumName, [track]);
    }
  }

  // Build options with visual grouping
  for (const [albumName, albumTracks] of albumGroups) {
    for (let i = 0; i < albumTracks.length; i++) {
      const track = albumTracks[i];
      if (!track) continue;

      const isFirst = i === 0;
      // Use track.label which includes rating stars (e.g., "Song.mp3 [4.5★]")
      // rather than track.trackName which is just the filename
      const trackLabel = track.label;

      let label: string;
      if (isFirst) {
        // First track shows album header with track info
        label = `\u250C ${trackLabel} \u2500 ${albumName}`;
      } else {
        // Subsequent tracks show indented track info
        label = `\u2502 ${trackLabel}`;
      }

      options.push({
        label,
        value: track.path,
        track,
        isFirstInGroup: isFirst,
        albumName,
      });
    }
  }

  return options;
}

/**
 * Filter a track based on filter string.
 *
 * Matches against track name, album name, or label (case-insensitive).
 * Including label allows filtering by rating stars.
 *
 * @param track - Track display info
 * @param lowerFilter - Lowercase filter string
 * @returns true if track matches filter
 */
function matchesFilter(track: TrackDisplayInfo, lowerFilter: string): boolean {
  return (
    track.trackName.toLowerCase().includes(lowerFilter) ||
    track.albumName.toLowerCase().includes(lowerFilter) ||
    track.label.toLowerCase().includes(lowerFilter)
  );
}

/**
 * Interactive track multi-select component.
 *
 * Features:
 * - Type-ahead filtering on track name or album name
 * - Album grouping via box-drawing character prefixes
 * - Display format: track number and name with album context
 * - Warning for large track counts (> 100)
 * - Source path in header
 *
 * Note: Since @inkjs/ui MultiSelect doesn't support Separator elements,
 * album grouping is achieved through label prefixes using box-drawing
 * characters for visual hierarchy.
 */
export function TrackSelector({
  tracks,
  sourcePath,
  pageSize,
  onSelect,
  onCancel,
}: TrackSelectorProps): React.ReactElement {
  const { exit } = useApp();
  const [filter, setFilter] = useState("");
  const [selectedCount, setSelectedCount] = useState(0);

  // Build grouped options (unfiltered, for when filter is empty)
  const groupedOptions = useMemo(() => buildGroupedOptions(tracks), [tracks]);

  // Filter tracks first, then rebuild grouped options to maintain consistent grouping.
  // This ensures that if the first track in an album doesn't match but later tracks do,
  // the filtered results still show proper album headers (┌) for each group.
  const filteredOptions = useMemo(() => {
    if (filter === "") {
      return groupedOptions;
    }
    const lowerFilter = filter.toLowerCase();

    // Filter at the track level first
    const matchingTracks = tracks.filter((track) => matchesFilter(track, lowerFilter));

    // Rebuild grouped options from filtered tracks
    return buildGroupedOptions(matchingTracks);
  }, [tracks, groupedOptions, filter]);

  // Build MultiSelect options
  const options: Option[] = useMemo(() => {
    return filteredOptions.map((opt) => ({
      label: opt.label,
      value: opt.value,
    }));
  }, [filteredOptions]);

  // Handle keyboard input for filtering and escape
  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      exit();
      return;
    }

    // Handle backspace - clear last character from filter
    if (key.backspace || key.delete) {
      setFilter((prev) => prev.slice(0, -1));
      return;
    }

    // Handle regular character input for filtering
    if (
      input &&
      input.length === 1 &&
      !key.ctrl &&
      !key.meta &&
      input !== " " && // Space is for toggling selection
      input !== "\r" && // Enter is for confirming
      input !== "\n" &&
      isValidFilterChar(input)
    ) {
      setFilter((prev) => {
        if (prev.length >= MAX_FILTER_LENGTH) {
          return prev;
        }
        return prev + input;
      });
    }
  });

  // Handle submit
  const handleSubmit = (values: string[]): void => {
    onSelect(values);
    exit();
  };

  // Track selection count changes
  const handleChange = (values: string[]): void => {
    setSelectedCount(values.length);
  };

  // Warning message for large lists
  const warningMessage =
    tracks.length > MAX_RECOMMENDED_TRACKS
      ? `Large track count (${tracks.length}). Consider album-level selection for better performance.`
      : undefined;

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold>Select tracks from {sourcePath}</Text>
        <Text color="gray"> ({selectedCount} selected)</Text>
      </Box>

      <Box marginBottom={1}>
        <Text>Filter: </Text>
        <Text color="cyan">
          {filter || <Text color="gray">type to filter by track or album...</Text>}
        </Text>
      </Box>

      {warningMessage && (
        <Box marginBottom={1}>
          <Text color="yellow">{warningMessage}</Text>
        </Box>
      )}

      <Box marginBottom={1}>
        <Text color="gray">
          Space: toggle | Enter: confirm | Escape: cancel | Backspace: clear filter
        </Text>
      </Box>

      {filteredOptions.length === 0 ? (
        <Text color="yellow">No tracks match the filter</Text>
      ) : (
        <MultiSelect
          options={options}
          onSubmit={handleSubmit}
          onChange={handleChange}
          visibleOptionCount={pageSize}
        />
      )}
    </Box>
  );
}
