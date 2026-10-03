/**
 * rfapps-specific error formatters.
 *
 * This module registers error formatters for rfapps-specific error types,
 * providing user-friendly error messages and actionable suggestions.
 *
 * @module rfapps-cli/lib/error-formatters
 */

import { registerErrorFormatter } from "@rfmedia/common";
import {
  ServiceNotFoundError,
  GroupNotFoundError,
  ProfileNotFoundError,
  ConfigNotFoundError,
  EnvFileNotFoundError,
  ConfigValidationError,
  ComposeFileParseError,
  DeploymentNotFoundError,
  InsufficientHistoryError,
  GenerationNotFoundError,
  PlanValidationError,
  InvalidArgumentError,
  ImagePullError,
  ServiceStartError,
  DockerCommandError,
  ParallelExecutionError,
  TagSelectorEmptyError,
} from "./errors.js";
import { ExitCode } from "./exit-codes.js";
import { findClosestMatch } from "./fuzzy-match.js";

let formattersRegistered = false;

/**
 * Registers all rfapps-specific error formatters.
 *
 * This function should be called early in the CLI initialization
 * to ensure formatters are available before any errors occur.
 *
 * Formatters are registered in order from most specific to most generic.
 */
export function registerRfappsErrorFormatters(): void {
  if (formattersRegistered) {
    return;
  }
  formattersRegistered = true;

  // 1. ServiceNotFoundError - Unknown service name
  registerErrorFormatter({
    canHandle: (error): error is ServiceNotFoundError => error instanceof ServiceNotFoundError,
    formatMessage: (error) => `Service '${error.serviceName}' not found`,
    getSuggestions: (error) => {
      const suggestions: string[] = [];

      const match =
        error.suggestion ?? findClosestMatch(error.serviceName, error.availableServices);
      if (match) {
        suggestions.push(`Did you mean '${match}'?`);
      }

      if (error.availableServices.length > 0 && error.availableServices.length < 10) {
        suggestions.push(`Available services: ${error.availableServices.join(", ")}`);
      }

      suggestions.push("Run rfapps status --all to see available services");
      suggestions.push("Run with --debug for more details");

      return suggestions;
    },
    exitCode: ExitCode.UsageError,
  });

  // 2. GroupNotFoundError - Unknown service group
  registerErrorFormatter({
    canHandle: (error): error is GroupNotFoundError => error instanceof GroupNotFoundError,
    formatMessage: (error) => `Unknown service group: '${error.groupName}'`,
    getSuggestions: (error) => {
      const suggestions: string[] = [];

      const match = error.suggestion ?? findClosestMatch(error.groupName, error.availableGroups);
      if (match) {
        suggestions.push(`Did you mean '${match}'?`);
      }

      if (error.availableGroups.length > 0) {
        suggestions.push(`Available groups: ${error.availableGroups.join(", ")}`);
      }

      suggestions.push("Check .rfapps.yaml groups configuration");
      suggestions.push("Run with --debug for more details");

      return suggestions;
    },
    exitCode: ExitCode.UsageError,
  });

  // 3. ProfileNotFoundError - Unknown profile name
  registerErrorFormatter({
    canHandle: (error): error is ProfileNotFoundError => error instanceof ProfileNotFoundError,
    formatMessage: (error) => `Unknown profile: '${error.profileName}'`,
    getSuggestions: (error) => {
      const suggestions: string[] = [];

      const match = error.suggestion ?? findClosestMatch(error.profileName, error.validProfiles);
      if (match) {
        suggestions.push(`Did you mean '${match}'?`);
      }

      if (error.validProfiles.length > 0) {
        suggestions.push(`Valid profiles: ${error.validProfiles.join(", ")}`);
      }

      suggestions.push("Run with --debug for more details");

      return suggestions;
    },
    exitCode: ExitCode.UsageError,
  });

  // 4. ConfigNotFoundError - Configuration file not found
  registerErrorFormatter({
    canHandle: (error): error is ConfigNotFoundError => error instanceof ConfigNotFoundError,
    formatMessage: () => "Configuration file not found",
    getSuggestions: (error) => {
      const suggestions: string[] = [];

      if (error.searchedPaths.length > 0) {
        suggestions.push(`Searched paths: ${error.searchedPaths.join(", ")}`);
      }

      suggestions.push("Run rfapps init to create a configuration file");
      suggestions.push("Run with --debug for more details");

      return suggestions;
    },
    exitCode: ExitCode.OperationalError,
  });

  // 5. EnvFileNotFoundError - Secrets env file missing
  registerErrorFormatter({
    canHandle: (error): error is EnvFileNotFoundError => error instanceof EnvFileNotFoundError,
    formatMessage: () => "Environment file not found",
    getSuggestions: (error) => [
      `Provided path: ${error.envFile}`,
      `Check the ${error.option} path`,
      "Run with --debug for more details",
    ],
    exitCode: ExitCode.UsageError,
  });

  // 6. ComposeFileParseError - Compose file parse failure
  registerErrorFormatter({
    canHandle: (error): error is ComposeFileParseError => error instanceof ComposeFileParseError,
    formatMessage: (error) => `Failed to parse compose file: ${error.reason}`,
    getSuggestions: (error) => [
      `Compose file: ${error.composePath}`,
      "Check YAML syntax and indentation",
      "Ensure the compose file exists and is readable",
      "Run with --debug for more details",
    ],
    exitCode: ExitCode.OperationalError,
  });

  // 7. ConfigValidationError - Configuration validation failure
  registerErrorFormatter({
    canHandle: (error): error is ConfigValidationError => error instanceof ConfigValidationError,
    formatMessage: (error) => `Invalid configuration: ${error.reason}`,
    getSuggestions: (error) => {
      const suggestions: string[] = [];

      if (error.field) {
        suggestions.push(`Check the '${error.field}' field in ${error.configSource}`);
      }

      const source = error.configSource.trim();
      if (source) {
        suggestions.push(`Review ${source} for configuration errors`);
      } else {
        suggestions.push("Review configuration for errors");
      }
      suggestions.push("Run with --debug for more details");

      return suggestions;
    },
    exitCode: ExitCode.OperationalError,
  });

  // 8. DeploymentNotFoundError - Deployment ID not found
  registerErrorFormatter({
    canHandle: (error): error is DeploymentNotFoundError =>
      error instanceof DeploymentNotFoundError,
    formatMessage: (error) =>
      `Deployment '${error.deploymentId}' not found for service '${error.service}'`,
    getSuggestions: () => [
      "Run rfapps history to see available deployments",
      "Run with --debug for more details",
    ],
    exitCode: ExitCode.OperationalError,
  });

  // 9. InsufficientHistoryError - Not enough rollback history
  registerErrorFormatter({
    canHandle: (error): error is InsufficientHistoryError =>
      error instanceof InsufficientHistoryError,
    formatMessage: (error) => `Insufficient rollback history for '${error.service}'`,
    getSuggestions: (error) => [
      `Requested ${error.requestedSteps} step(s), but only ${error.availableSteps} available`,
      "Run rfapps history to see available deployments",
      "Run with --debug for more details",
    ],
    exitCode: ExitCode.OperationalError,
  });

  // 9b. GenerationNotFoundError - Generation snapshot not found
  registerErrorFormatter({
    canHandle: (error): error is GenerationNotFoundError =>
      error instanceof GenerationNotFoundError,
    formatMessage: (error) =>
      `No generation found for service '${error.service}' matching ${error.criteria}`,
    getSuggestions: (error) => [
      `Run rfapps history --generations -s ${error.service} to see available generations`,
      "Run with --debug for more details",
    ],
    exitCode: ExitCode.OperationalError,
  });

  // 10. PlanValidationError - Plan file validation failure
  registerErrorFormatter({
    canHandle: (error): error is PlanValidationError => error instanceof PlanValidationError,
    formatMessage: (error) => `Plan validation failed: ${error.reason}`,
    getSuggestions: (error) => [
      `Plan file: ${error.planPath}`,
      "Run rfapps plan to regenerate the plan",
      "Run with --debug for more details",
    ],
    exitCode: ExitCode.OperationalError,
  });

  // 11. InvalidArgumentError - Invalid CLI argument value
  registerErrorFormatter({
    canHandle: (error): error is InvalidArgumentError => error instanceof InvalidArgumentError,
    formatMessage: (error) =>
      `Invalid value '${error.value}' for ${error.argument}: ${error.reason}`,
    getSuggestions: (error) => {
      const suggestions: string[] = [];

      if (error.validValues && error.validValues.length > 0) {
        suggestions.push(`Valid values: ${error.validValues.join(", ")}`);
      }

      suggestions.push("Run with --debug for more details");

      return suggestions;
    },
    exitCode: ExitCode.UsageError,
  });

  // 12. ImagePullError - Docker image pull failure
  registerErrorFormatter({
    canHandle: (error): error is ImagePullError => error instanceof ImagePullError,
    formatMessage: (error) => `Failed to pull images for ${error.services.join(", ")}`,
    getSuggestions: () => [
      "Check network connectivity",
      "Verify image names in compose.yml",
      "Run with --debug for more details",
    ],
    exitCode: ExitCode.OperationalError,
  });

  // 13. ServiceStartError - Docker service start failure
  registerErrorFormatter({
    canHandle: (error): error is ServiceStartError => error instanceof ServiceStartError,
    formatMessage: (error) => `Failed to start services: ${error.services.join(", ")}`,
    getSuggestions: () => [
      "Check service logs with docker logs",
      "Run rfapps status for service health",
      "Run with --debug for more details",
    ],
    exitCode: ExitCode.OperationalError,
  });

  // 14. DockerCommandError - Generic Docker command failure
  registerErrorFormatter({
    canHandle: (error): error is DockerCommandError => error instanceof DockerCommandError,
    formatMessage: (error) => `Docker ${error.operation} failed for ${error.services.join(", ")}`,
    getSuggestions: (error) => {
      const suggestions: string[] = [];

      if (error.isSSH) {
        suggestions.push("Check SSH connection to the Docker host");
        suggestions.push("Verify Docker context configuration");
      }

      suggestions.push("Check Docker daemon status");
      suggestions.push("Run with --debug for more details");

      return suggestions;
    },
    exitCode: ExitCode.OperationalError,
  });

  // 15. ParallelExecutionError - Parallel service execution failure
  registerErrorFormatter({
    canHandle: (error): error is ParallelExecutionError => error instanceof ParallelExecutionError,
    formatMessage: (error) =>
      `Parallel execution failed in phase ${error.phase}: ${error.failedServices.length} of ${error.totalServices} services failed`,
    getSuggestions: (error) => {
      const suggestions: string[] = [];

      suggestions.push(`Failed services: ${error.failedServices.join(", ")}`);
      suggestions.push(`Phase: ${error.phase}, Workers: ${error.workerCount}`);
      suggestions.push("Check service logs with docker logs for failed services");
      suggestions.push("Try running failed services individually without --parallel");
      suggestions.push("Run with --debug for more details");

      return suggestions;
    },
    exitCode: ExitCode.OperationalError,
  });

  // 16. TagSelectorEmptyError - Tag selector matched no services
  registerErrorFormatter({
    canHandle: (error): error is TagSelectorEmptyError => error instanceof TagSelectorEmptyError,
    formatMessage: (error) => {
      const headline = `Tag selector matched no services: ${error.patterns.join(", ")}`;

      // Stale mapping entries are the specific diagnosis; they replace the
      // generic "narrows, does not widen" explanation.
      if (error.unresolvedServices.length > 0) {
        return [
          headline,
          "",
          "  'tags.mapping' assigns this tag to services that are absent from compose.yml:",
          `    ${error.unresolvedServices.join(", ")}`,
        ].join("\n");
      }

      const context: string[] = [];
      if (error.baseSelectors.length > 0) {
        context.push(`  The selector also included: ${error.baseSelectors.join(", ")}`);
      }
      context.push("  --tag narrows the selection; it does not widen it.");

      return [headline, "", ...context].join("\n");
    },
    getSuggestions: (error) => {
      if (error.unresolvedServices.length > 0) {
        return [
          "Remove the stale entries from tags.mapping in rfapps.config.yaml",
          "Run 'rfapps validate' to see every stale tag reference",
          "Run with --debug for more details",
        ];
      }

      const suggestions: string[] = [];

      // The suggestion is segment-aware (findClosestTag); the flat
      // findClosestMatch fallback used by the lookup formatters would score
      // slash-delimited tag paths wrongly, so there is no fallback here.
      if (error.suggestion) {
        suggestions.push(`Did you mean '${error.suggestion}'?`);
      }

      suggestions.push(`Run 'rfapps tag list' to see all ${error.knownTags.length} known tags`);

      if (error.baseSelectors.length > 0) {
        suggestions.push(`Drop ${error.baseSelectors.join(", ")} to search all tagged services`);
      }

      suggestions.push("Run with --debug for more details");

      return suggestions;
    },
    exitCode: ExitCode.UsageError,
  });
}
