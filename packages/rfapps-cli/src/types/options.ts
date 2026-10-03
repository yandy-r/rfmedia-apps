/**
 * Command options types for rfapps CLI
 */

import type { EnvTool, OutputFormat } from "@rfmedia/common";

import type { RfappsConfig } from "./config.js";
import type { StagedFailurePolicy } from "./staged.js";

// Re-export EnvTool and OutputFormat for backwards compatibility
export type { EnvTool, OutputFormat } from "@rfmedia/common";

/**
 * Common options shared across all commands
 */
export interface GlobalOptions {
  /** Preview actions without executing */
  dryRun: boolean;
  /** Enable debug output */
  debug: boolean;
  /** Output in JSON format */
  json: boolean;
  /** Output format for structured output (json, yaml, csv, table, text) */
  output?: OutputFormat;
  /** Enable verbose output (show detailed progress) */
  verbose: boolean;
  /** Skip confirmation prompts */
  yes: boolean;
  /** Path to env file for dotenvx secrets injection */
  useDotenvx?: string;
  /** Path to env file for 1Password CLI secrets injection */
  useOp?: string;
}

/**
 * Env tool execution config for Docker command wrapping
 */
export interface EnvToolExecConfig {
  /** Which tool to use */
  tool: EnvTool;
  /** Path to environment file */
  envFile: string;
}

/**
 * Options for service targeting
 */
export interface ServiceTargetOptions {
  /** Target a specific service */
  service?: string;
  /** Target multiple services (comma-separated) */
  services?: string[];
  /** Target a service group */
  group?: string;
  /**
   * Narrow the target set by hierarchical tag pattern.
   * One array element per `--tag` occurrence; within an element, commas OR.
   * Across elements, AND. `undefined` => resolution is structurally unchanged
   * from pre-#63 behavior. NEVER defaulted to `[]` — see the Commander note in §7.4.
   */
  tag?: string[];
  /** Disable automatic sidecar linking */
  noSidecars: boolean;
}

/**
 * Options for Docker Compose file resolution
 */
export interface ComposeOptions {
  /** Path to Docker Compose file */
  composePath?: string;
  /** Path to environment file */
  envFile?: string;
  /** Docker Compose profile to use */
  profile?: string;
}

/**
 * Combined options for pull command
 */
export interface PullOptions extends GlobalOptions, ServiceTargetOptions, ComposeOptions {}

/**
 * Combined options for build command
 */
export interface BuildOptions extends GlobalOptions, ServiceTargetOptions, ComposeOptions {
  /** Skip pulling images before building */
  skipPull: boolean;
}

/**
 * Options specific to deploy command
 */
export interface DeployOptions extends GlobalOptions, ServiceTargetOptions, ComposeOptions {
  /** Run fail-closed resource conflict validation before deployment */
  validateFirst: boolean;
  /** Scan resolved images for known vulnerabilities before any mutation */
  scan: boolean;
  /** Skip pulling images before deploying */
  skipPull: boolean;
  /** Force recreate containers even if unchanged */
  forceRecreate: boolean;
  /** Exit with partial success when mixed service outcomes occur */
  allowPartial?: boolean;
  /** Wait for dependency readiness after start */
  waitForReady: boolean;
  /** Health check timeout in seconds */
  healthTimeout: number;
  /** Execute operations in parallel using dependency phases */
  parallel?: boolean;
  /** Maximum concurrent workers for parallel execution */
  workers?: number;
  /** Roll out services in dependency-ordered batches with a health gate */
  staged?: boolean;
  /** Services per staged batch */
  batchSize?: number;
  /** Staged batch failure policy */
  onFailure?: StagedFailurePolicy;
}

/**
 * Options specific to stop command
 */
export interface StopOptions extends GlobalOptions, ServiceTargetOptions, ComposeOptions {}

/**
 * Options specific to rebuild command
 */
export interface RebuildOptions extends GlobalOptions, ServiceTargetOptions, ComposeOptions {
  /** Skip pulling images before rebuilding */
  skipPull: boolean;
  /** Wait for dependency readiness after start */
  waitForReady: boolean;
  /** Health check timeout in seconds */
  healthTimeout: number;
  /** Execute operations in parallel using dependency phases */
  parallel?: boolean;
  /** Maximum concurrent workers for parallel execution */
  workers?: number;
}

/**
 * Options specific to delete command
 */
export interface DeleteOptions extends GlobalOptions, ServiceTargetOptions, ComposeOptions {
  /** Also remove volumes */
  volumes: boolean;
  /** Also remove images */
  images: boolean;
}

/**
 * Options specific to prune command
 */
export interface PruneOptions extends GlobalOptions, ServiceTargetOptions, ComposeOptions {
  /** Also prune images */
  images: boolean;
  /** Also prune volumes */
  volumes: boolean;
}

/**
 * Options specific to status command
 */
export interface StatusOptions extends GlobalOptions, ServiceTargetOptions, ComposeOptions {
  /** Show all services (including stopped) */
  all: boolean;
  /** Show health status */
  health: boolean;
  /** Show resource stats */
  stats: boolean;
  /** Show recent logs */
  logs: boolean;
}

/**
 * Options specific to health command
 */
export interface HealthOptions extends GlobalOptions, ServiceTargetOptions, ComposeOptions {
  /** Wait for dependency readiness before returning */
  waitForReady: boolean;
  /** Health check timeout in seconds */
  healthTimeout: number;
}

/**
 * Docker Compose profiles
 *
 * This is a string type to allow any profile name defined in the config file.
 * Runtime validation is performed via isValidProfile() in lib/services.ts.
 */
export type Profile = string;

/**
 * Extract env tool config from global options
 * Returns undefined if no env tool is configured
 */
export function getEnvToolExecConfig(
  globalOptions: {
    useDotenvx?: string;
    useOp?: string;
  },
  config?: Pick<RfappsConfig, "envTool" | "envFile">,
): EnvToolExecConfig | undefined {
  if (globalOptions.useDotenvx !== undefined) {
    return { tool: "dotenvx", envFile: globalOptions.useDotenvx };
  }
  if (globalOptions.useOp !== undefined) {
    return { tool: "op", envFile: globalOptions.useOp };
  }
  if (config === undefined) {
    return undefined;
  }
  if (config.envTool.tool === "none" || config.envFile.trim() === "") {
    return undefined;
  }
  return { tool: config.envTool.tool, envFile: config.envFile };
}
