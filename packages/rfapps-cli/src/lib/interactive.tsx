/**
 * Interactive service selection UI component for rfapps CLI.
 *
 * Provides a terminal-based multi-select interface for selecting Docker Compose
 * services, displaying service status indicators (running/stopped/unhealthy),
 * and supporting type-ahead filtering.
 *
 * Uses ink (React for CLI) with @inkjs/ui components.
 *
 * @module rfapps-cli/lib/interactive
 */

import { access } from "node:fs/promises";

import React, { useState, useMemo } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { MultiSelect, type Option } from "@inkjs/ui";
import { colors, logError, logDebug } from "@rfmedia/common";

import type { ContainerState, HealthStatus } from "../types/results.js";
import type { ServiceDisplayInfo } from "../types/interactive.js";
import type { DockerExecOptions } from "./docker.js";
import { getServiceStatusMap } from "./service-status.js";
import { getComposeServices } from "./docker.js";

/**
 * Delay in milliseconds to allow ink buffer to drain before readline takes over.
 *
 * After Ink exits raw mode, any buffered input (like the Enter keypress that
 * confirmed selection) needs time to be discarded before subsequent readline
 * prompts can safely use stdin.
 */
const STDIN_CLEANUP_DELAY_MS = 100;

/**
 * Maximum length for filter input.
 *
 * Limits the filter string to prevent excessive memory usage or display issues.
 * 64 characters is sufficient for any reasonable service name filter.
 */
const MAX_FILTER_LENGTH = 64;

/**
 * Sanitize and validate filter input character.
 *
 * Only allows alphanumeric characters, hyphens, underscores, and dots
 * which are valid in Docker service names.
 *
 * @param char - Single character input from keyboard
 * @returns true if character is valid for filtering
 */
function isValidFilterChar(char: string): boolean {
  // Only allow characters valid in service names: alphanumeric, hyphen, underscore, dot
  return /^[a-zA-Z0-9\-_.]$/.test(char);
}

/**
 * Get the status indicator for a service based on its state and health.
 *
 * Status indicators follow the pattern established in plan.ts:
 * - Running healthy: green checkmark
 * - Running unhealthy: yellow exclamation
 * - Stopped/Exited: dim dash
 * - Created (never started): dim circle
 */
function getStatusIndicator(state: ContainerState, health: HealthStatus): string {
  if (state === "running") {
    if (health === "healthy") {
      return colors.green("✓");
    }
    if (health === "unhealthy") {
      return colors.yellow("!");
    }
    // Running without health check or health starting
    return colors.green("✓");
  }

  if (state === "exited" || state === "dead" || state === "paused") {
    return colors.dim("-");
  }

  // Created or other states
  return colors.dim("○");
}

/**
 * Build display label for a service with status indicator.
 */
function buildDisplayLabel(name: string, state: ContainerState, health: HealthStatus): string {
  const indicator = getStatusIndicator(state, health);
  return `${indicator} ${name}`;
}

/**
 * Filter out sidecar services (matching *-ts pattern).
 *
 * When `sidecars.enabled: true` and a mapping is configured, sidecars are
 * automatically linked to their main services and should not appear in the
 * interactive selection.
 */
function filterSidecars(services: string[]): string[] {
  return services.filter((name) => !name.endsWith("-ts"));
}

/**
 * Props for the ServiceSelector component.
 */
interface ServiceSelectorProps {
  services: ServiceDisplayInfo[];
  pageSize: number;
  onSelect: (selected: string[]) => void;
  onCancel: () => void;
}

/**
 * Interactive service selection component.
 *
 * Features:
 * - Type-ahead filtering (type letters to filter, backspace to clear)
 * - Multi-select with spacebar toggle
 * - Enter to confirm
 * - Escape to cancel
 *
 * Note: We use useInput for filtering instead of TextInput to allow
 * spacebar to pass through to MultiSelect for toggling selections.
 * MultiSelect manages its own selection state internally.
 */
function ServiceSelector({
  services,
  pageSize,
  onSelect,
  onCancel,
}: ServiceSelectorProps): React.ReactElement {
  const { exit } = useApp();
  const [filter, setFilter] = useState("");

  // Filter services based on user input
  const filteredServices = useMemo(() => {
    if (filter === "") {
      return services;
    }
    const lowerFilter = filter.toLowerCase();
    return services.filter((s: ServiceDisplayInfo) => s.name.toLowerCase().includes(lowerFilter));
  }, [services, filter]);

  // Build options for MultiSelect
  const options: Option[] = useMemo(() => {
    return filteredServices.map((service: ServiceDisplayInfo) => ({
      label: service.displayLabel,
      value: service.name,
    }));
  }, [filteredServices]);

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
      isValidFilterChar(input) // Sanitize input to valid service name characters
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
    onSelect(values);
    exit();
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold>Select services</Text>
        <Text color="gray"> (use Space to toggle, Enter to confirm)</Text>
      </Box>

      <Box marginBottom={1}>
        <Text>Filter: </Text>
        <Text color="cyan">{filter || <Text color="gray">type to filter...</Text>}</Text>
      </Box>

      <Box marginBottom={1}>
        <Text color="gray">
          Space: toggle | Enter: confirm | Escape: cancel | Backspace: clear filter
        </Text>
      </Box>

      {filteredServices.length === 0 ? (
        <Text color="yellow">No services match the filter</Text>
      ) : (
        <MultiSelect
          options={options}
          highlightText={filter}
          onSubmit={handleSubmit}
          visibleOptionCount={pageSize}
        />
      )}
    </Box>
  );
}

/**
 * Select services interactively using a terminal UI.
 *
 * @param composePath - Path to the Docker Compose file
 * @param projectDir - Project directory for container matching
 * @param options - Optional configuration including env tool for secrets injection and page size
 * @returns Array of selected service names, or null if cancelled
 *
 * @example
 * ```typescript
 * const selected = await selectServicesInteractive('./compose.yml', '/project');
 * if (selected === null) {
 *   console.log('Selection cancelled');
 * } else {
 *   console.log(`Selected: ${selected.join(', ')}`);
 * }
 * ```
 */
export async function selectServicesInteractive(
  composePath: string,
  projectDir: string,
  options: Pick<DockerExecOptions, "envTool" | "env" | "replaceEnv"> & { pageSize?: number } = {},
): Promise<string[] | null> {
  const { envTool, env, replaceEnv, pageSize = 10 } = options;
  const execution = {
    ...(envTool === undefined ? {} : { envTool }),
    ...(env === undefined ? {} : { env }),
    ...(replaceEnv === undefined ? {} : { replaceEnv }),
  };

  try {
    // Validate compose file exists before attempting to read services
    try {
      await access(composePath);
    } catch {
      logError(`Compose file not found: ${composePath}`);
      return null;
    }

    // Get all services from compose file
    const allServices = await getComposeServices(composePath, execution);
    if (allServices.length === 0) {
      logError("No services found in compose file");
      return null;
    }

    // Filter out sidecars
    const mainServices = filterSidecars(allServices);
    logDebug(
      `Found ${mainServices.length} main services (filtered ${allServices.length - mainServices.length} sidecars)`,
    );

    // Get status for all services (pass preloaded services to avoid redundant fetch)
    const statusMap = await getServiceStatusMap(composePath, projectDir, {
      ...execution,
      preloadedServices: allServices,
    });

    // Build display info for each service
    const serviceDisplayInfos: ServiceDisplayInfo[] = mainServices.map((name: string) => {
      const status = statusMap.get(name);
      const state: ContainerState = status?.state ?? "created";
      const health: HealthStatus = status?.health ?? "none";

      return {
        name,
        state,
        health,
        displayLabel: buildDisplayLabel(name, state, health),
      };
    });

    // Sort services: running first, then alphabetically
    serviceDisplayInfos.sort((a: ServiceDisplayInfo, b: ServiceDisplayInfo) => {
      const aRunning = a.state === "running" ? 0 : 1;
      const bRunning = b.state === "running" ? 0 : 1;
      if (aRunning !== bRunning) {
        return aRunning - bRunning;
      }
      return a.name.localeCompare(b.name);
    });

    // Track selection result
    let selectedServices: string[] | null = null;

    // Render the interactive component
    const { unmount, waitUntilExit } = render(
      <ServiceSelector
        services={serviceDisplayInfos}
        pageSize={pageSize}
        onSelect={(selected: string[]) => {
          selectedServices = selected;
        }}
        onCancel={() => {
          selectedServices = null;
        }}
      />,
    );

    // Clean up terminal first
    await waitUntilExit();
    unmount();

    // Restore stdin to normal state after Ink exits
    // Ink puts stdin in raw mode and the Enter keypress that confirms selection
    // remains buffered. We must drain it before subsequent readline prompts.
    try {
      if (process.stdin.isTTY) {
        // Exit raw mode first
        process.stdin.setRawMode(false);

        // Force buffer clear by temporarily entering flowing mode
        // This drains any pending input (like the Enter keypress)
        const discardHandler = (): void => {
          // Intentionally discard any data
        };
        process.stdin.on("data", discardHandler);
        process.stdin.resume();

        // Wait for any buffered data to flow through and be discarded
        await new Promise((resolve) => setTimeout(resolve, STDIN_CLEANUP_DELAY_MS));

        // Clean up and pause stdin for readline to take over
        process.stdin.removeListener("data", discardHandler);
        process.stdin.pause();
      }
    } catch (stdinError) {
      // Stdin cleanup failed, but we can still return results
      // This can happen in edge cases with terminal state
      logDebug(
        `Stdin cleanup warning: ${stdinError instanceof Error ? stdinError.message : String(stdinError)}`,
      );
    }

    return selectedServices;
  } catch (error) {
    // Handle cancellation errors gracefully
    if (error instanceof Error) {
      if (error.name === "ExitPromptError" || error.message.includes("cancel")) {
        return null;
      }
      logError(`Interactive selection failed: ${error.message}`);
    }
    return null;
  }
}
