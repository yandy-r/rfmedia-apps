/**
 * Service mappings, sidecar linking, and service groups for rfapps CLI
 *
 * All service mappings are now loaded from configuration files.
 * This module provides utility functions that operate on config-driven data.
 */

import type { RfappsConfig, Profile } from "../types/index.js";

/**
 * Build reverse mapping: sidecar -> main services
 * This allows bidirectional sidecar linking
 */
function buildSidecarMainMap(sidecarMapping: Record<string, string>): Record<string, string[]> {
  const map: Record<string, string[]> = {};

  for (const [main, sidecar] of Object.entries(sidecarMapping)) {
    if (map[sidecar] === undefined) {
      map[sidecar] = [];
    }
    map[sidecar].push(main);
  }

  return map;
}

/**
 * Get the sidecar for a main service (if any)
 */
export function getSidecarForService(service: string, config: RfappsConfig): string | undefined {
  return config.sidecars.mapping[service];
}

/**
 * Get main services for a sidecar (if any)
 */
export function getMainServicesForSidecar(sidecar: string, config: RfappsConfig): string[] {
  const reverseMap = buildSidecarMainMap(config.sidecars.mapping);
  return reverseMap[sidecar] ?? [];
}

/**
 * Check if a service name is a sidecar
 */
export function isSidecar(service: string, config: RfappsConfig): boolean {
  const reverseMap = buildSidecarMainMap(config.sidecars.mapping);
  return service.endsWith("-ts") && reverseMap[service] !== undefined;
}

/**
 * Get the profile for a service
 */
export function getProfileForService(service: string, config: RfappsConfig): Profile {
  return config.profiles.mapping[service] ?? "all";
}

/**
 * Expand a service group name to its constituent services
 */
export function expandServiceGroup(group: string, config: RfappsConfig): string[] | undefined {
  return config.groups[group];
}

/**
 * Get all available service groups
 */
export function getAvailableGroups(config: RfappsConfig): string[] {
  return Object.keys(config.groups);
}

/**
 * Expand services with sidecar linking.
 *
 * Performs bidirectional sidecar expansion:
 * - Main service -> adds its Tailscale sidecar
 * - Sidecar -> adds its main service(s)
 *
 * This ensures that when operating on a service with a sidecar, both
 * are handled together to prevent stale network state.
 *
 * @param services - Initial list of service names
 * @param config - Configuration containing sidecar mappings
 * @returns Expanded list with all linked services (duplicates removed)
 *
 * @example
 * ```typescript
 * // If config has plex -> plex-ts mapping:
 * expandServicesWithSidecars(['plex'], config)
 * // Returns: ['plex', 'plex-ts']
 *
 * // Bidirectional - sidecar also expands:
 * expandServicesWithSidecars(['plex-ts'], config)
 * // Returns: ['plex-ts', 'plex']
 * ```
 */
export function expandServicesWithSidecars(services: string[], config: RfappsConfig): string[] {
  const seen = new Set<string>();
  const expanded: string[] = [];

  for (const service of services) {
    if (seen.has(service)) continue;
    seen.add(service);
    expanded.push(service);

    // Add sidecar for main service
    const sidecar = getSidecarForService(service, config);
    if (sidecar !== undefined && !seen.has(sidecar)) {
      seen.add(sidecar);
      expanded.push(sidecar);
    }

    // Add main services for sidecar (bidirectional linking)
    const mainServices = getMainServicesForSidecar(service, config);
    for (const main of mainServices) {
      if (!seen.has(main)) {
        seen.add(main);
        expanded.push(main);
      }
    }
  }

  return expanded;
}

/**
 * Auto-detect required profiles for a list of services.
 *
 * Looks up each service in the profile mapping and returns unique profiles.
 * Services not in the mapping default to 'all' profile.
 *
 * This is used to automatically select profiles when targeting specific
 * services rather than requiring manual profile specification.
 *
 * @param services - List of service names to find profiles for
 * @param config - Configuration containing profile mappings
 * @returns Array of unique profiles required for the services
 *
 * @example
 * ```typescript
 * // If plex is in 'media' profile and traefik in 'core':
 * autoDetectProfiles(['plex', 'traefik'], config)
 * // Returns: ['media', 'core']
 * ```
 */
export function autoDetectProfiles(services: string[], config: RfappsConfig): Profile[] {
  const profiles = new Set<Profile>();

  for (const service of services) {
    profiles.add(getProfileForService(service, config));
  }

  return Array.from(profiles);
}

/**
 * Validate a profile name
 */
export function isValidProfile(profile: string, config: RfappsConfig): profile is Profile {
  return config.profiles.validProfiles.includes(profile as Profile);
}
