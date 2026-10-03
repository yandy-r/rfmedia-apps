/**
 * Custom error classes for rfapps CLI.
 *
 * These errors provide structured context for the error formatting pipeline
 * (`registerErrorFormatter` -> `formatError` -> `handleCliError`).
 *
 * All error classes follow the pattern established by `SecretsInjectionError`:
 * - Extend `Error`
 * - Call `super(message)` with a descriptive message
 * - Set `this.name` to the class name as a string literal
 * - Store context as `readonly` fields
 *
 * These classes are dependency-free -- they do NOT import from actions, lib,
 * or external packages.
 *
 * @module rfapps-cli/lib/errors
 */

/**
 * Thrown when a service name is not found in the compose configuration.
 */
export class ServiceNotFoundError extends Error {
  /** The service name that was not found */
  readonly serviceName: string;
  /** List of valid service names from compose configuration */
  readonly availableServices: string[];
  /** Fuzzy-match suggestion, if a close match was found */
  readonly suggestion?: string;

  /**
   * Creates a new ServiceNotFoundError.
   *
   * @param serviceName - The service name that was not found
   * @param availableServices - List of valid service names
   * @param suggestion - Optional fuzzy-match suggestion
   */
  constructor(serviceName: string, availableServices: string[], suggestion?: string) {
    super(`Service '${serviceName}' not found`);
    this.name = "ServiceNotFoundError";
    this.serviceName = serviceName;
    this.availableServices = availableServices;
    this.suggestion = suggestion;
  }
}

/**
 * Thrown when a service group name is not found in the configuration.
 */
export class GroupNotFoundError extends Error {
  /** The group name that was not found */
  readonly groupName: string;
  /** List of valid group names from configuration */
  readonly availableGroups: string[];
  /** Fuzzy-match suggestion, if a close match was found */
  readonly suggestion?: string;

  /**
   * Creates a new GroupNotFoundError.
   *
   * @param groupName - The group name that was not found
   * @param availableGroups - List of valid group names
   * @param suggestion - Optional fuzzy-match suggestion
   */
  constructor(groupName: string, availableGroups: string[], suggestion?: string) {
    super(`Unknown service group: '${groupName}'`);
    this.name = "GroupNotFoundError";
    this.groupName = groupName;
    this.availableGroups = availableGroups;
    this.suggestion = suggestion;
  }
}

/**
 * Thrown when a profile name is not valid.
 */
export class ProfileNotFoundError extends Error {
  /** The profile name that was not found */
  readonly profileName: string;
  /** List of valid profile names */
  readonly validProfiles: string[];
  /** Fuzzy-match suggestion, if a close match was found */
  readonly suggestion?: string;

  /**
   * Creates a new ProfileNotFoundError.
   *
   * @param profileName - The profile name that was not found
   * @param validProfiles - List of valid profile names
   * @param suggestion - Optional fuzzy-match suggestion
   */
  constructor(profileName: string, validProfiles: string[], suggestion?: string) {
    super(`Unknown profile: '${profileName}'`);
    this.name = "ProfileNotFoundError";
    this.profileName = profileName;
    this.validProfiles = validProfiles;
    this.suggestion = suggestion;
  }
}

/**
 * Thrown when the configuration file cannot be found at any searched path.
 */
export class ConfigNotFoundError extends Error {
  /** Paths that were searched for the configuration file */
  readonly searchedPaths: string[];

  /**
   * Creates a new ConfigNotFoundError.
   *
   * @param searchedPaths - Paths that were searched for the configuration file
   */
  constructor(searchedPaths: string[]) {
    super("Configuration file not found");
    this.name = "ConfigNotFoundError";
    this.searchedPaths = searchedPaths;
  }
}

/**
 * Thrown when a required environment file is missing.
 */
export class EnvFileNotFoundError extends Error {
  /** CLI option that provided the environment file */
  readonly option: string;
  /** Environment file path that was not found */
  readonly envFile: string;

  /**
   * Creates a new EnvFileNotFoundError.
   *
   * @param option - CLI option used to provide the env file
   * @param envFile - Environment file path that was not found
   */
  constructor(option: string, envFile: string) {
    super("Environment file not found");
    this.name = "EnvFileNotFoundError";
    this.option = option;
    this.envFile = envFile;
  }
}

/**
 * Thrown when configuration validation fails.
 */
export class ConfigValidationError extends Error {
  /** The configuration field that is invalid */
  readonly field: string;
  /** The source of the configuration (file path or description) */
  readonly configSource: string;
  /** The reason the configuration is invalid */
  readonly reason: string;

  /**
   * Creates a new ConfigValidationError.
   *
   * @param field - The configuration field that is invalid
   * @param configSource - The source of the configuration
   * @param reason - The reason the configuration is invalid
   */
  constructor(field: string, configSource: string, reason: string) {
    super(`Invalid configuration: ${reason}`);
    this.name = "ConfigValidationError";
    this.field = field;
    this.configSource = configSource;
    this.reason = reason;
  }
}

/**
 * Thrown when a compose file cannot be read or parsed.
 */
export class ComposeFileParseError extends Error {
  /** Path to the compose file that failed to parse */
  readonly composePath: string;
  /** The reason parsing failed */
  readonly reason: string;

  /**
   * Creates a new ComposeFileParseError.
   *
   * @param composePath - Path to the compose file
   * @param reason - Reason parsing failed
   */
  constructor(composePath: string, reason: string) {
    super(`Failed to parse compose file: ${reason}`);
    this.name = "ComposeFileParseError";
    this.composePath = composePath;
    this.reason = reason;
  }
}

/**
 * Thrown when a Docker Compose command fails.
 */
export class DockerCommandError extends Error {
  /** The Docker operation that failed (e.g., "up", "down", "pull") */
  readonly operation: string;
  /** Standard error output from the Docker command */
  readonly stderr: string;
  /** Exit code from the Docker command */
  readonly exitCode: number;
  /** Services that were targeted by the command */
  readonly services: string[];
  /** Whether the failure was related to an SSH connection */
  readonly isSSH: boolean;

  /**
   * Creates a new DockerCommandError.
   *
   * @param operation - The Docker operation that failed
   * @param stderr - Standard error output from the Docker command
   * @param exitCode - Exit code from the Docker command
   * @param services - Services that were targeted by the command
   * @param isSSH - Whether the failure was related to an SSH connection
   */
  constructor(
    operation: string,
    stderr: string,
    exitCode: number,
    services: string[],
    isSSH: boolean,
  ) {
    super(`Docker ${operation} failed for ${services.join(", ")}`);
    this.name = "DockerCommandError";
    this.operation = operation;
    this.stderr = stderr;
    this.exitCode = exitCode;
    this.services = services;
    this.isSSH = isSSH;
  }
}

/**
 * Thrown when Docker image pull fails for one or more services.
 */
export class ImagePullError extends Error {
  /** Services whose images failed to pull */
  readonly services: string[];
  /** Standard error output from the pull command */
  readonly stderr: string;

  /**
   * Creates a new ImagePullError.
   *
   * @param services - Services whose images failed to pull
   * @param stderr - Standard error output from the pull command
   */
  constructor(services: string[], stderr: string) {
    super(`Failed to pull images for ${services.join(", ")}`);
    this.name = "ImagePullError";
    this.services = services;
    this.stderr = stderr;
  }
}

/**
 * Thrown when Docker services fail to start.
 */
export class ServiceStartError extends Error {
  /** Services that failed to start */
  readonly services: string[];
  /** Standard error output from the start command */
  readonly stderr: string;

  /**
   * Creates a new ServiceStartError.
   *
   * @param services - Services that failed to start
   * @param stderr - Standard error output from the start command
   */
  constructor(services: string[], stderr: string) {
    super(`Failed to start services: ${services.join(", ")}`);
    this.name = "ServiceStartError";
    this.services = services;
    this.stderr = stderr;
  }
}

/**
 * Thrown when a deployment ID is not found in the history database.
 */
export class DeploymentNotFoundError extends Error {
  /** The deployment ID that was not found */
  readonly deploymentId: string;
  /** The service the deployment was searched for */
  readonly service: string;

  /**
   * Creates a new DeploymentNotFoundError.
   *
   * @param deploymentId - The deployment ID that was not found
   * @param service - The service the deployment was searched for
   */
  constructor(deploymentId: string, service: string) {
    super(`Deployment '${deploymentId}' not found for service '${service}'`);
    this.name = "DeploymentNotFoundError";
    this.deploymentId = deploymentId;
    this.service = service;
  }
}

/**
 * Thrown when there is insufficient rollback history for a service.
 */
export class InsufficientHistoryError extends Error {
  /** The service that lacks sufficient history */
  readonly service: string;
  /** The number of rollback steps requested */
  readonly requestedSteps: number;
  /** The number of rollback steps available */
  readonly availableSteps: number;

  /**
   * Creates a new InsufficientHistoryError.
   *
   * @param service - The service that lacks sufficient history
   * @param requestedSteps - The number of rollback steps requested
   * @param availableSteps - The number of rollback steps available
   */
  constructor(service: string, requestedSteps: number, availableSteps: number) {
    super(`Insufficient rollback history for '${service}'`);
    this.name = "InsufficientHistoryError";
    this.service = service;
    this.requestedSteps = requestedSteps;
    this.availableSteps = availableSteps;
  }
}

/**
 * Thrown when a generation snapshot is not found for a service.
 *
 * Raised by restore-by-generation (`--to-generation`) when the generation
 * number does not exist, and by restore-by-time (`--to-time`) when no
 * generation existed at or before the requested time.
 */
export class GenerationNotFoundError extends Error {
  /** The service the generation was searched for */
  readonly service: string;
  /** Human-readable description of the lookup criteria (e.g. "generation 5") */
  readonly criteria: string;

  /**
   * Creates a new GenerationNotFoundError.
   *
   * @param service - The service the generation was searched for
   * @param criteria - Description of the lookup criteria that failed
   */
  constructor(service: string, criteria: string) {
    super(`No generation found for service '${service}' matching ${criteria}`);
    this.name = "GenerationNotFoundError";
    this.service = service;
    this.criteria = criteria;
  }
}

/**
 * Thrown when a deployment plan fails validation.
 */
export class PlanValidationError extends Error {
  /** Path to the plan file */
  readonly planPath: string;
  /** The reason the plan validation failed */
  readonly reason: string;

  /**
   * Creates a new PlanValidationError.
   *
   * @param planPath - Path to the plan file
   * @param reason - The reason the plan validation failed
   */
  constructor(planPath: string, reason: string) {
    super(`Plan validation failed: ${reason}`);
    this.name = "PlanValidationError";
    this.planPath = planPath;
    this.reason = reason;
  }
}

/**
 * Thrown when a CLI argument has an invalid value.
 */
export class InvalidArgumentError extends Error {
  /** The argument name */
  readonly argument: string;
  /** The invalid value that was provided */
  readonly value: string;
  /** The reason the value is invalid */
  readonly reason: string;
  /** Valid values for the argument, if applicable */
  readonly validValues?: string[];

  /**
   * Creates a new InvalidArgumentError.
   *
   * @param argument - The argument name
   * @param value - The invalid value that was provided
   * @param reason - The reason the value is invalid
   * @param validValues - Optional list of valid values
   */
  constructor(argument: string, value: string, reason: string, validValues?: string[]) {
    super(`Invalid value '${value}' for ${argument}: ${reason}`);
    this.name = "InvalidArgumentError";
    this.argument = argument;
    this.value = value;
    this.reason = reason;
    this.validValues = validValues;
  }
}

/**
 * Thrown when parallel execution of services fails in one or more phases.
 */
export class ParallelExecutionError extends Error {
  /** The execution phase where failure(s) occurred */
  readonly phase: number;
  /** Services that failed during execution */
  readonly failedServices: string[];
  /** Total number of services in the execution */
  readonly totalServices: number;
  /** Number of concurrent workers used */
  readonly workerCount: number;

  /**
   * Creates a new ParallelExecutionError.
   *
   * @param message - Descriptive error message
   * @param phase - The execution phase where failure(s) occurred
   * @param failedServices - Services that failed during execution
   * @param totalServices - Total number of services in the execution
   * @param workerCount - Number of concurrent workers used
   */
  constructor(
    message: string,
    phase: number,
    failedServices: string[],
    totalServices: number,
    workerCount: number,
  ) {
    super(message);
    this.name = "ParallelExecutionError";
    this.phase = phase;
    this.failedServices = failedServices;
    this.totalServices = totalServices;
    this.workerCount = workerCount;
  }
}

/**
 * Thrown when a `--tag` selector narrows the selection down to nothing.
 *
 * `--tag` intersects with the other targeting axes; it never widens them. An
 * empty intersection must therefore throw rather than fall through to the
 * `services: []` sentinel, which means "no explicit target" and would silently
 * target every service in the compose project.
 */
export class TagSelectorEmptyError extends Error {
  /** The raw `--tag` pattern sources that produced the empty selection */
  readonly patterns: string[];
  /** Human-readable descriptions of the non-tag selector flags that were also present */
  readonly baseSelectors: string[];
  /** Every tag known to the tag index, for "run tag list" guidance */
  readonly knownTags: string[];
  /** Fuzzy-match suggestion for the first pattern, if a close tag was found */
  readonly suggestion?: string;
  /**
   * Services the patterns matched in `tags.mapping` that are absent from compose.yml.
   *
   * Design gap closed here: design §4.5 lists only the four fields above, but
   * §7.2 P4 and §9.5 require the formatter to name stale `tags.mapping` entries
   * instead of reporting a bare "matched no services". The parameter is optional
   * so the §7.4 four-argument call site stays verbatim.
   */
  readonly unresolvedServices: readonly string[];

  /**
   * Creates a new TagSelectorEmptyError.
   *
   * @param patterns - The raw `--tag` pattern sources that matched nothing
   * @param baseSelectors - The non-tag selector flags that were also present
   * @param knownTags - Every tag known to the tag index
   * @param suggestion - Optional fuzzy-match suggestion for the first pattern
   * @param unresolvedServices - Matched `tags.mapping` services absent from compose.yml
   */
  constructor(
    patterns: string[],
    baseSelectors: string[],
    knownTags: string[],
    suggestion?: string,
    unresolvedServices: readonly string[] = [],
  ) {
    super(`Tag selector matched no services: ${patterns.join(", ")}`);
    this.name = "TagSelectorEmptyError";
    this.patterns = patterns;
    this.baseSelectors = baseSelectors;
    this.knownTags = knownTags;
    if (suggestion !== undefined) this.suggestion = suggestion;
    this.unresolvedServices = unresolvedServices;
  }
}
