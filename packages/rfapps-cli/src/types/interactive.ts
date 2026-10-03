/**
 * Types for interactive service selection feature.
 *
 * Provides type definitions for the interactive multi-select service menu
 * that triggers when no service targeting flags are provided in a TTY environment.
 */

import type { ContainerState, HealthStatus } from "./results.js";

/**
 * Service display information for interactive selection UI.
 *
 * Contains all the data needed to render a service in the multi-select menu,
 * including its current state and a pre-formatted display label.
 */
export interface ServiceDisplayInfo {
  /** Service name from compose file */
  name: string;
  /** Current container state (running/exited/created/etc) */
  state: ContainerState;
  /** Health check status (healthy/unhealthy/starting/none) */
  health: HealthStatus;
  /** Formatted string for UI display with status indicator */
  displayLabel: string;
}

/**
 * Options for the interactive service selection component.
 *
 * Configures the multi-select interface with available services
 * and optional initial state.
 */
export interface InteractiveSelectionOptions {
  /** Available services to select from */
  services: ServiceDisplayInfo[];
  /** Optional initial filter text for type-ahead filtering */
  filter?: string;
  /** Optional pre-selected service names */
  preSelected?: string[];
}

/**
 * Result of interactive service selection.
 *
 * Returns an array of selected service names on successful selection,
 * or null if the user cancelled the selection (Escape/Ctrl+C).
 */
export type InteractiveSelectionResult = string[] | null;
