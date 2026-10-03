/**
 * Types for parallel service execution with dependency-aware phasing.
 *
 * Parallel execution decomposes bulk Docker Compose operations into
 * topologically-sorted phases based on `depends_on` and `network_mode`
 * dependencies, then executes services concurrently within each phase.
 */

import type { FailedOperation } from "./results.js";

/**
 * Parallel execution configuration for rfapps config file.
 *
 * Controls whether parallel execution is enabled by default and
 * the maximum number of concurrent workers.
 */
export interface ParallelConfig {
  /** Enable parallel execution by default */
  enabled: boolean;
  /** Maximum concurrent workers for parallel execution */
  workers: number;
}

/**
 * Represents one topologically-sorted group of services with no inter-dependencies.
 *
 * Services within a phase can execute concurrently because all their
 * dependencies are satisfied by prior phases.
 */
export interface ExecutionPhase {
  /** Phase number (0-indexed, Phase 0 has no dependencies) */
  phase: number;
  /** Services to execute in this phase */
  services: string[];
  /** Services from prior phases that this phase depends on */
  dependsOn: string[];
}

/**
 * Result of executing one phase of parallel operations.
 */
export interface PhaseResult {
  /** Phase number that was executed */
  phase: number;
  /** Services that were targeted in this phase */
  services: string[];
  /** Services that completed successfully */
  succeeded: string[];
  /** Services that failed with error details */
  failed: FailedOperation[];
}

/**
 * Aggregated result across all phases of a parallel execution.
 */
export interface ParallelExecutionResult {
  /** Per-phase execution results */
  phases: PhaseResult[];
  /** Total number of services across all phases */
  totalServices: number;
  /** All services that completed successfully */
  succeeded: string[];
  /** All services that failed with error details */
  failed: FailedOperation[];
}

/**
 * Output of the topological sort -- the dependency graph with phase groupings.
 *
 * If `hasCycles` is true, the graph contains circular dependencies and
 * `cycleServices` lists the services involved in the cycle.
 */
export interface DependencyGraph {
  /** Topologically-sorted execution phases */
  phases: ExecutionPhase[];
  /** Whether a dependency cycle was detected */
  hasCycles: boolean;
  /** Services involved in the detected cycle (only present when hasCycles is true) */
  cycleServices?: string[];
  /** Per-service dependency list (present when !hasCycles; used for per-service skip logic) */
  dependencyMap?: Map<string, string[]>;
}
