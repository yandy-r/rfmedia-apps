/**
 * Base multi-select component for interactive selection UI.
 *
 * Provides a reusable wrapper implementing common patterns:
 * - Type-ahead filtering with keyboard input
 * - Multi-select with space toggle
 * - Enter to confirm, Escape to cancel
 * - Selection count display in header
 *
 * @module rfmedia-cli/lib/interactive/BaseSelector
 */

import React, { useState, useMemo } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { MultiSelect, type Option } from "@inkjs/ui";

import { MAX_FILTER_LENGTH } from "./constants.js";

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
 * Generic display info interface for selector options.
 * All specific display info types (Source, Album, Track, Delete) should
 * extend this base interface.
 */
export interface BaseDisplayInfo {
  /** Value identifier for the option (typically path) */
  readonly value: string;
  /** Display label shown in the menu */
  readonly label: string;
}

/**
 * Props for the BaseSelector component.
 */
export interface BaseSelectorProps<T extends BaseDisplayInfo> {
  /** Items to display in the multi-select */
  readonly items: readonly T[];
  /** Number of visible options in the menu */
  readonly pageSize: number;
  /** Header text shown above the selection */
  readonly header: string;
  /** Callback when selection is confirmed */
  readonly onSelect: (selected: readonly string[]) => void;
  /** Callback when selection is cancelled */
  readonly onCancel: () => void;
  /** Optional function to filter items based on filter string */
  readonly filterFn?: (item: T, filter: string) => boolean;
  /** Optional warning message to display (e.g., for large item counts) */
  readonly warningMessage?: string;
}

/**
 * Default filter function that matches against the label.
 */
function defaultFilterFn<T extends BaseDisplayInfo>(item: T, filter: string): boolean {
  return item.label.toLowerCase().includes(filter.toLowerCase());
}

/**
 * Base interactive multi-select component.
 *
 * Features:
 * - Type-ahead filtering (type letters to filter, backspace to clear)
 * - Multi-select with spacebar toggle
 * - Enter to confirm
 * - Escape to cancel
 * - Selection count display in header
 * - Filter highlighting in options
 *
 * Note: Space is reserved for selection toggle and is excluded from filter input.
 */
export function BaseSelector<T extends BaseDisplayInfo>({
  items,
  pageSize,
  header,
  onSelect,
  onCancel,
  filterFn = defaultFilterFn,
  warningMessage,
}: BaseSelectorProps<T>): React.ReactElement {
  const { exit } = useApp();
  const [filter, setFilter] = useState("");
  const [selectedCount, setSelectedCount] = useState(0);

  // Filter items based on user input
  const filteredItems = useMemo(() => {
    if (filter === "") {
      return items;
    }
    return items.filter((item) => filterFn(item, filter));
  }, [items, filter, filterFn]);

  // Build options for MultiSelect
  const options: Option[] = useMemo(() => {
    return filteredItems.map((item) => ({
      label: item.label,
      value: item.value,
    }));
  }, [filteredItems]);

  // Handle keyboard input for filtering and escape
  // Letters and numbers update filter, backspace clears, escape cancels
  // Space, enter, and arrows are passed through to MultiSelect
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
    // Only add valid filter characters with length limit
    if (
      input &&
      input.length === 1 &&
      !key.ctrl &&
      !key.meta &&
      input !== " " && // Space is for toggling selection
      input !== "\r" && // Enter is for confirming
      input !== "\n" &&
      isValidFilterChar(input) // Sanitize input to valid characters
    ) {
      setFilter((prev) => {
        // Enforce maximum filter length
        if (prev.length >= MAX_FILTER_LENGTH) {
          return prev;
        }
        return prev + input;
      });
    }
  });

  // Handle submit - MultiSelect passes the selected values
  const handleSubmit = (values: string[]): void => {
    try {
      onSelect(values);
      exit();
    } catch (error) {
      // Log error and attempt graceful exit
      // eslint-disable-next-line no-console
      console.error("Error during selection submission:", error);
      try {
        exit();
      } catch {
        // Exit failed, but we've already logged the original error
      }
    }
  };

  // Track selection count changes via onChange
  const handleChange = (values: string[]): void => {
    setSelectedCount(values.length);
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold>{header}</Text>
        <Text color="gray"> ({selectedCount} selected)</Text>
      </Box>

      <Box marginBottom={1}>
        <Text>Filter: </Text>
        <Text color="cyan">{filter || <Text color="gray">type to filter...</Text>}</Text>
        {filter && (
          <Text color="gray">
            {" "}
            ({filter.length}/{MAX_FILTER_LENGTH})
          </Text>
        )}
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

      {filteredItems.length === 0 ? (
        <Text color="yellow">No items match the filter</Text>
      ) : (
        <MultiSelect
          options={options}
          highlightText={filter}
          onSubmit={handleSubmit}
          onChange={handleChange}
          visibleOptionCount={pageSize}
        />
      )}
    </Box>
  );
}
