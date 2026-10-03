/**
 * Configuration types for rfapps CLI
 */

import type { HardenConfig } from "./hardening.js";
import type { EnvTool, Profile } from "./options.js";
import type { ParallelConfig } from "./parallel.js";
import type { ScanConfig } from "./security-scan.js";
import type { TagConfig } from "./tags.js";

/**
 * Service sidecar mapping configuration
 */
export interface SidecarConfig {
  /** Map of service name to sidecar name */
  mapping: Record<string, string>;
  /** Whether sidecar linking is enabled by default */
  enabled: boolean;
}

/**
 * Service group configuration
 * Direct mapping of group name to service list
 */
export type GroupConfig = Record<string, string[]>;

/**
 * Profile configuration
 */
export interface ProfileConfig {
  /** Map of service name to profile */
  mapping: Record<string, Profile>;
  /** Default profile to use */
  defaultProfile: Profile;
  /** Valid profile names */
  validProfiles: Profile[];
}

/**
 * Health check configuration
 */
export interface HealthCheckConfig {
  /** Timeout in seconds */
  timeout: number;
  /** Interval between checks in seconds */
  interval: number;
  /** Number of retries before failing */
  retries: number;
  /** Whether deploy/rebuild/apply should wait for dependency readiness */
  waitForReady: boolean;
}

/**
 * Environment tool configuration
 */
export interface EnvToolConfig {
  /** Which tool to use for environment variable injection */
  tool: EnvTool;
  /** Path to dotenvx binary (if using dotenvx) */
  dotenvxPath?: string;
  /** 1Password CLI options (if using op) */
  opOptions?: {
    /** Path to op binary */
    path?: string;
    /** Additional flags to pass */
    flags?: string[];
  };
}

/**
 * Docker configuration
 */
export interface DockerConfig {
  /** Docker context to use */
  context?: string;
  /** SSH retry configuration for remote contexts */
  sshRetry?: {
    /** Maximum number of retries */
    maxRetries: number;
    /** Delay between retries in milliseconds */
    delayMs: number;
  };
}

/**
 * Interactive selection configuration
 */
export interface InteractiveConfig {
  /** Number of services visible in the selection menu (default: 10) */
  pageSize: number;
}

/**
 * State persistence configuration
 */
export interface StateConfig {
  /** Path to state.db, default ~/.rfapps/state.db */
  dbPath?: string;
  /** Whether to record state, default true */
  enabled?: boolean;
}

/**
 * Lint rule suppression entry.
 *
 * When `service` is omitted, the rule is ignored for all services.
 */
export interface LintIgnoreRule {
  /** Lint rule identifier to ignore */
  rule: string;
  /** Limit ignore to a specific service (omit for all services) */
  service?: string;
}

/**
 * Lint configuration for compose validation.
 */
export interface LintConfig {
  /** Rules to suppress in lint output */
  ignore?: LintIgnoreRule[];
}

/**
 * Complete rfapps configuration
 */
export interface RfappsConfig {
  /** Default compose file path */
  composePath: string;
  /** Default environment file path */
  envFile: string;
  /** Service sidecar configuration */
  sidecars: SidecarConfig;
  /** Service group configuration */
  groups: GroupConfig;
  /** Profile configuration */
  profiles: ProfileConfig;
  /** Health check configuration */
  healthCheck: HealthCheckConfig;
  /** Environment tool configuration */
  envTool: EnvToolConfig;
  /** Docker configuration */
  docker: DockerConfig;
  /** Interactive selection configuration */
  interactive: InteractiveConfig;
  /** State persistence configuration */
  state: StateConfig;
  /** Parallel execution configuration */
  parallel: ParallelConfig;
  /** Lint configuration */
  lint?: LintConfig;
  /** Image vulnerability scanning configuration (`plan --scan`, `deploy --scan`) */
  scan?: ScanConfig;
  /** Compose security hardening configuration (`rfapps harden`) */
  harden?: HardenConfig;
  /** Hierarchical service tagging configuration (`--tag`, `rfapps tag`) */
  tags?: TagConfig;
}

/**
 * Partial config for merging with defaults
 */
export type PartialRfappsConfig = Partial<{
  composePath: string;
  envFile: string;
  sidecars: Partial<SidecarConfig>;
  groups: GroupConfig;
  profiles: Partial<ProfileConfig>;
  healthCheck: Partial<HealthCheckConfig>;
  envTool: Partial<EnvToolConfig>;
  docker: Partial<DockerConfig>;
  interactive: Partial<InteractiveConfig>;
  state: Partial<StateConfig>;
  parallel: Partial<ParallelConfig>;
  lint: Partial<LintConfig>;
  scan: Partial<ScanConfig>;
  harden: Partial<HardenConfig>;
  tags: Partial<TagConfig>;
}>;
