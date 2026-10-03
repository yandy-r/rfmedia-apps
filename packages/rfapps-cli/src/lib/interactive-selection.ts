/**
 * Integration helper for interactive service selection.
 *
 * Consolidates the interactive selection logic for use across all action handlers,
 * providing a single integration point that:
 * - Handles service targeting flags (-s, --services, -g, --tag)
 * - Narrows the resolved set by hierarchical tag pattern (`--tag`)
 * - Shows interactive selection when appropriate (TTY, no flags, no --yes)
 * - Applies sidecar expansion based on config
 * - Auto-detects required profiles
 *
 * This module is the single chokepoint through which every resolver-backed command
 * path inherits `--tag`, so the ordering rules in {@link resolveServicesWithInteractive}
 * are contractual rather than incidental (design §7.2, post-conditions P1-P6).
 *
 * @module rfapps-cli/lib/interactive-selection
 */

import { logInfo } from "@rfmedia/common";

import type { ServiceTargetOptions, Profile, RfappsConfig } from "../types/index.js";
import type { DockerExecOptions } from "./docker.js";
import {
  expandServicesWithSidecars,
  expandServiceGroup,
  getAvailableGroups,
  autoDetectProfiles,
} from "./services.js";
import { shouldShowInteractiveSelection } from "./interactive-check.js";
import { selectServicesInteractive } from "./interactive.js";
import { GroupNotFoundError, InvalidArgumentError, TagSelectorEmptyError } from "./errors.js";
import { findClosestMatch } from "./fuzzy-match.js";
import {
  applyTagAxis,
  explicitSelectorFlagNames,
  hasExplicitSelector,
  hasServicesSelector,
} from "./selector.js";
import { getTagIndex } from "./tags/tag-index.js";
import { diagnoseEmptyTagSelection } from "./tags/tag-suggestions.js";
import { parseComposeFile, validateServiceNames } from "./validation.js";

/**
 * Options for service resolution with interactive selection.
 *
 * Extends ServiceTargetOptions (which carries `service`, `services`, `group` and `tag`)
 * with the --yes flag check.
 * Note: Commander.js sets sidecars=false for --no-sidecars, so check sidecars === false.
 */
export interface ResolveServicesSelection extends ServiceTargetOptions {
  /** Auto-confirm flag (--yes) - skips interactive selection */
  yes?: boolean;
  /** Sidecars flag - Commander sets to false for --no-sidecars */
  sidecars?: boolean;
}

/**
 * The injectable shape of {@link resolveServicesWithInteractive}.
 *
 * `backup`, `reconcile` and `update` each declare a `resolveServices` dependency for
 * testing. Before this type they re-declared the selection object structurally, so a new
 * targeting axis had to be added to three separate copies and a missed copy silently
 * dropped the axis at runtime while still typechecking (design §7.6).
 *
 * `TExecution` is generic because the existing seams genuinely diverge: `backup` passes
 * `Pick<DockerExecOptions, "env" | "replaceEnv">` while `reconcile` and `update` pass
 * `{ envTool?: EnvToolExecConfig }`.
 */
export type ResolveServicesFn<TResult, TExecution> = (
  selection: ResolveServicesSelection,
  config: RfappsConfig,
  composePath: string,
  projectDir: string,
  execution: TExecution,
) => Promise<TResult | null>;

/**
 * Result of service resolution.
 */
interface ResolveResult {
  /** Resolved service names (empty array means "all services") */
  services: string[];
  /** Auto-detected profiles for the services */
  profiles: Profile[];
  /** Number of services before sidecar expansion */
  preSidecarCount: number;
  /** Whether sidecars were expanded */
  sidecarsExpanded: boolean;
}

/**
 * Resolve services with interactive selection support.
 *
 * This function consolidates service resolution logic for all action handlers:
 *
 * 1. If service targeting flags provided (-s, --services, -g, --tag):
 *    - Expands group to services if -g provided
 *    - Collects all specified services
 *    - Validates the collected names, then narrows them by `--tag`
 *    - Applies sidecar expansion if enabled
 *
 * 2. If no targeting flags and shouldShowInteractiveSelection() returns true:
 *    - Shows interactive service selection UI
 *    - Returns null if user cancels (Escape)
 *    - Returns null if user confirms with nothing selected
 *
 * 3. If not interactive (non-TTY, JSON mode, --yes):
 *    - Returns empty services array (means "all services")
 *
 * @param rawOptions - Service targeting options from CLI
 * @param config - Loaded rfapps configuration
 * @param composePath - Path to Docker Compose file
 * @param projectDir - Project directory for container matching
 * @param options - Optional configuration including env tool for secrets injection
 * @returns Resolved services and profiles, or null if cancelled/no selection
 * @throws InvalidArgumentError when `--services` was supplied but names no service
 * @throws GroupNotFoundError when `-g` names an unknown group
 * @throws ServiceNotFoundError when a named service is absent from compose.yml
 * @throws TagSelectorEmptyError when `--tag` narrows the target set to nothing
 *
 * @example
 * ```typescript
 * const resolved = await resolveServicesWithInteractive(options, config, composePath, projectDir);
 * if (resolved === null) {
 *   return; // User cancelled or no services selected
 * }
 * const { services, profiles } = resolved;
 * ```
 */
export async function resolveServicesWithInteractive(
  rawOptions: ResolveServicesSelection,
  config: RfappsConfig,
  composePath: string,
  projectDir: string,
  options: Pick<DockerExecOptions, "envTool" | "env" | "replaceEnv"> = {},
): Promise<ResolveResult | null> {
  let services: string[] = [];

  // FAIL CLOSED on a `--services` value that was supplied but denotes nothing.
  //
  // `hasServicesSelector` deliberately reads `""`, `","` and `"  "` as ABSENT — the deploy
  // `--staged` preflight in cli.ts depends on that reading — but "absent" must NOT decay into
  // "target the whole Compose project" here: the resolver's `[]` return is the overloaded
  // sentinel callers turn into `undefined`, so a script whose `--services "$SVCS"` expanded
  // empty would silently `delete`/`prune`/`stop` every service.
  //
  // THE PRECONDITION IS `!== undefined`, NOT `.length > 0`. Most actions reach this function
  // via `rawOptions.services?.split(",")`, where a supplied flag always arrives as a non-empty
  // array — but `import`, `reconcile`, `update` and `backup` additionally strip empty entries,
  // so for them the very same `--services ""` arrives as `[]`. `[]` therefore cannot be read as
  // "no flag": `actions/import.ts` has no pre-validation of its own, and tolerating `[]` let
  // `rfapps import --services "" --adopt --yes` adopt every running service. The optional
  // property is the only "no flag" signal — no call site ever defaults `services` to `[]` —
  // so rejecting every supplied-but-empty shape here is both correct and the single layer
  // that all 20 resolver-backed paths inherit.
  if (rawOptions.services !== undefined && !hasServicesSelector(rawOptions.services)) {
    throw new InvalidArgumentError(
      "--services",
      // Rendered as a JSON array rather than re-joined: the empty-filtering callers above
      // have already destroyed the operator's literal text, and `Invalid value ''` cannot
      // distinguish `--services ""` from `--services " "` from `[]`. Echoing exactly what
      // this function received keeps the message honest about what it can actually see.
      JSON.stringify(rawOptions.services),
      "Must name at least one service",
    );
  }

  // Check if any service targeting flags are provided (selector site 1).
  // The predicate lives in ./selector.js so every axis - including --tag - is declared
  // exactly once; a copy that missed an axis would silently widen the target set.
  const hasAnyTarget = hasExplicitSelector(rawOptions);

  if (hasAnyTarget) {
    // Delegate to existing service/group expansion pattern

    // Expand group if provided
    if (rawOptions.group !== undefined) {
      const groupServices = expandServiceGroup(rawOptions.group, config);
      if (groupServices === undefined) {
        const groupName = rawOptions.group;
        const availableGroups = getAvailableGroups(config);
        const suggestion = findClosestMatch(groupName, availableGroups);
        throw new GroupNotFoundError(groupName, availableGroups, suggestion);
      }
      services.push(...groupServices);
    }

    // Add single service if provided
    if (rawOptions.service !== undefined) {
      services.push(rawOptions.service);
    }

    // Add multiple services if provided
    if (rawOptions.services !== undefined) {
      services.push(...rawOptions.services);
    }

    // Deduplicate services to handle overlaps between groups and individual services
    services = [...new Set(services)];

    // Validate the BASE names against the compose file BEFORE the tag intersection (P3).
    // Running validation after the intersection would make ServiceNotFoundError
    // unreachable whenever --tag is present: the matched set is a subset of the compose
    // universe, so a misspelled name is filtered out before validation could see it, and
    // `deploy -s plexx --tag "media/**"` would report a misleading "tag matched nothing"
    // instead of "did you mean plex?".
    if (services.length > 0) {
      await validateServiceNames(services, composePath);
    }

    // P1 is STRUCTURAL: when --tag is absent, NOTHING below runs. No index is built, no
    // compose file is read, no ConfigValidationError can be raised. Without this guard a
    // single malformed `tags.mapping` entry would break `rfapps deploy -s plex` on all 20
    // resolver-backed paths, and every such invocation would newly pay a YAML parse of
    // every config layer.
    if (rawOptions.tag !== undefined && rawOptions.tag.length > 0) {
      const universe = await parseComposeFile(composePath);
      const index = await getTagIndex(config, composePath, universe);
      const axis = applyTagAxis(rawOptions.tag, index, universe);

      if (axis.kind === "present") {
        // An empty BASE means "no name/group axis was given", so the tag axis narrows the
        // whole compose universe rather than nothing.
        const base = services.length > 0 ? services : universe;
        const narrowed = base.filter((service) => axis.matched.has(service));

        // P2, the single most important rule: NEVER fall through to `[]`. That value is an
        // overloaded sentinel meaning "no explicit target - let Compose operate on the
        // whole project", so a zero-match glob returning it would silently target every
        // service, including under `rfapps delete`.
        if (narrowed.length === 0) {
          const diagnosis = diagnoseEmptyTagSelection(axis.terms, axis.matched, index);

          throw new TagSelectorEmptyError(
            axis.terms.map((term) => term.source),
            explicitSelectorFlagNames({ ...rawOptions, tag: undefined }),
            [...index.allTags],
            diagnosis.suggestion,
            diagnosis.staleServices,
          );
        }

        services = narrowed;
      }
    }
  } else if (shouldShowInteractiveSelection({ ...rawOptions })) {
    // Show interactive selection UI
    const selected = await selectServicesInteractive(composePath, projectDir, {
      ...(options.envTool === undefined ? {} : { envTool: options.envTool }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.replaceEnv === undefined ? {} : { replaceEnv: options.replaceEnv }),
      pageSize: config.interactive.pageSize,
    });

    // User cancelled (Escape)
    if (selected === null) {
      logInfo("Selection cancelled");
      return null;
    }

    // User confirmed with nothing selected
    if (selected.length === 0) {
      logInfo("No services selected");
      return null;
    }

    services = selected;
  }
  // else: non-interactive mode (non-TTY, JSON, --yes) - services stays empty (means "all services")

  // Track pre-sidecar count for force-recreate detection
  const preSidecarCount = services.length;

  // Apply sidecar expansion if enabled
  // Commander.js sets sidecars=false for --no-sidecars, undefined otherwise
  const sidecarsDisabled = rawOptions.sidecars === false || rawOptions.noSidecars;
  if (!sidecarsDisabled && config.sidecars.enabled && services.length > 0) {
    services = expandServicesWithSidecars(services, config);
  }

  // Detect if sidecars were actually expanded
  const sidecarsExpanded = services.length > preSidecarCount && preSidecarCount > 0;

  // Auto-detect profiles for the services
  const profiles =
    services.length > 0 ? autoDetectProfiles(services, config) : [config.profiles.defaultProfile];

  return { services, profiles, preSidecarCount, sidecarsExpanded };
}
