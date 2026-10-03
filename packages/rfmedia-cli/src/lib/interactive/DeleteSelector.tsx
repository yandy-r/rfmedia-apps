/**
 * Delete selector component for interactive delete item selection.
 *
 * Provides a multi-select interface for selecting suffixed copies to delete,
 * with artist-based visual grouping using box-drawing characters.
 *
 * Features:
 * - Type-ahead filtering on artist name or suffix
 * - Artist grouping with box-drawing characters
 * - Warning display for large item counts
 * - Selection count in header
 *
 * @module rfmedia-cli/lib/interactive/DeleteSelector
 */

import React, { useState, useMemo } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { MultiSelect, type Option } from "@inkjs/ui";

import type { DeleteDisplayInfo } from "../../types/interactive.js";
import { MAX_FILTER_LENGTH } from "./constants.js";

/** Maximum items before showing a warning about list size */
const MAX_ITEMS_WARNING = 50;

/**
 * Props for the DeleteSelector component.
 */
export interface DeleteSelectorProps {
  /** Items to display in the multi-select */
  readonly items: readonly DeleteDisplayInfo[];
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
 * Group items by artist and add visual prefixes for grouping display.
 *
 * Uses box-drawing characters to create visual separation:
 * - First item in group shows: "artistName"
 * - All items show their suffix with a vertical line prefix
 *
 * @param items - Delete display info items to group
 * @returns Array of options with grouping prefixes in labels
 */
function buildGroupedOptions(
  items: readonly DeleteDisplayInfo[],
): Array<{ label: string; value: string; artistName: string }> {
  // Group items by artist
  const artistGroups = new Map<string, DeleteDisplayInfo[]>();

  for (const item of items) {
    const existing = artistGroups.get(item.artistName);
    if (existing) {
      existing.push(item);
    } else {
      artistGroups.set(item.artistName, [item]);
    }
  }

  // Build options with visual grouping prefixes
  const options: Array<{ label: string; value: string; artistName: string }> = [];

  // Sort artist groups alphabetically
  const sortedArtists = [...artistGroups.keys()].sort((a, b) => a.localeCompare(b));

  for (const artistName of sortedArtists) {
    const artistItems = artistGroups.get(artistName);
    if (!artistItems || artistItems.length === 0) continue;

    // First item shows the artist header with suffix
    const firstItem = artistItems[0];
    if (firstItem) {
      options.push({
        label: `\u250C ${artistName} - ${firstItem.suffix}`,
        value: firstItem.path,
        artistName,
      });
    }

    // Remaining items show with vertical line prefix
    for (let i = 1; i < artistItems.length; i++) {
      const item = artistItems[i];
      if (item) {
        options.push({
          label: `\u2502 ${item.suffix}`,
          value: item.path,
          artistName,
        });
      }
    }
  }

  return options;
}

/**
 * Delete selector component for interactive item selection.
 *
 * Features:
 * - Type-ahead filtering (matches against artist name or suffix)
 * - Multi-select with spacebar toggle
 * - Enter to confirm, Escape to cancel
 * - Selection count display in header
 * - Artist grouping with box-drawing characters
 * - Warning for large item counts (> 50)
 *
 * Note: Space is reserved for selection toggle and excluded from filter input.
 */
export function DeleteSelector({
  items,
  pageSize,
  onSelect,
  onCancel,
}: DeleteSelectorProps): React.ReactElement {
  const { exit } = useApp();
  const [filter, setFilter] = useState("");
  const [selectedCount, setSelectedCount] = useState(0);

  // Build grouped options for display
  const groupedOptions = useMemo(() => buildGroupedOptions(items), [items]);

  // Filter items based on user input (matches artist name or suffix)
  const filteredOptions = useMemo(() => {
    if (filter === "") {
      return groupedOptions;
    }
    const lowerFilter = filter.toLowerCase();

    // Filter items that match artist name or suffix
    const matchingValues = new Set<string>();
    for (const item of items) {
      if (
        item.artistName.toLowerCase().includes(lowerFilter) ||
        item.suffix.toLowerCase().includes(lowerFilter)
      ) {
        matchingValues.add(item.path);
      }
    }

    // Rebuild grouped options with only matching items
    const matchingItems = items.filter((item) => matchingValues.has(item.path));
    return buildGroupedOptions(matchingItems);
  }, [items, groupedOptions, filter]);

  // Convert to MultiSelect options format
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

    // Handle regular character input for filtering (not space, arrows, enter)
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

  // Handle submit - MultiSelect passes the selected values
  const handleSubmit = (values: string[]): void => {
    onSelect(values);
    exit();
  };

  // Track selection count changes via onChange
  const handleChange = (values: string[]): void => {
    setSelectedCount(values.length);
  };

  // Generate warning message if item count exceeds threshold
  const warningMessage =
    items.length > MAX_ITEMS_WARNING
      ? `Found ${items.length} items. Large lists may be slow to navigate. Consider using source filters.`
      : undefined;

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold>Select items to delete</Text>
        <Text color="gray"> ({selectedCount} selected)</Text>
      </Box>

      <Box marginBottom={1}>
        <Text>Filter: </Text>
        <Text color="cyan">{filter || <Text color="gray">type to filter...</Text>}</Text>
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
        <Text color="yellow">No items match the filter</Text>
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
