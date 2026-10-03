import { describe, expect, it } from "vitest";
import {
  ComposeFileParseError,
  ConfigNotFoundError,
  ConfigValidationError,
  DeploymentNotFoundError,
  DockerCommandError,
  EnvFileNotFoundError,
  GenerationNotFoundError,
  GroupNotFoundError,
  ImagePullError,
  InsufficientHistoryError,
  InvalidArgumentError,
  PlanValidationError,
  ProfileNotFoundError,
  ServiceNotFoundError,
  ServiceStartError,
  TagSelectorEmptyError,
} from "./errors.js";

function expectErrorIdentity(error: Error, type: new (...args: never[]) => Error): void {
  expect(error).toBeInstanceOf(type);
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe(type.name);
}

describe("rfapps custom errors", () => {
  it("constructs ServiceNotFoundError with lookup context", () => {
    const availableServices = ["plex", "traefik"];
    const error = new ServiceNotFoundError("plx", availableServices, "plex");

    expectErrorIdentity(error, ServiceNotFoundError);
    expect(error).toMatchObject({
      message: "Service 'plx' not found",
      serviceName: "plx",
      availableServices,
      suggestion: "plex",
    });
    expect(new ServiceNotFoundError("plx", availableServices).suggestion).toBeUndefined();
  });

  it("constructs GroupNotFoundError with lookup context", () => {
    const availableGroups = ["media-stack", "arr-stack"];
    const error = new GroupNotFoundError("media-stck", availableGroups, "media-stack");

    expectErrorIdentity(error, GroupNotFoundError);
    expect(error).toMatchObject({
      message: "Unknown service group: 'media-stck'",
      groupName: "media-stck",
      availableGroups,
      suggestion: "media-stack",
    });
    expect(new GroupNotFoundError("unknown", availableGroups).suggestion).toBeUndefined();
  });

  it("constructs ProfileNotFoundError with lookup context", () => {
    const validProfiles = ["core", "media", "all"];
    const error = new ProfileNotFoundError("cor", validProfiles, "core");

    expectErrorIdentity(error, ProfileNotFoundError);
    expect(error).toMatchObject({
      message: "Unknown profile: 'cor'",
      profileName: "cor",
      validProfiles,
      suggestion: "core",
    });
    expect(new ProfileNotFoundError("unknown", validProfiles).suggestion).toBeUndefined();
  });

  it("constructs ConfigNotFoundError with searched paths", () => {
    const searchedPaths = ["/home/user/.rfapps.yaml", "/etc/rfapps/config.yaml"];
    const error = new ConfigNotFoundError(searchedPaths);

    expectErrorIdentity(error, ConfigNotFoundError);
    expect(error).toMatchObject({
      message: "Configuration file not found",
      searchedPaths,
    });
    expect(new ConfigNotFoundError([]).searchedPaths).toEqual([]);
  });

  it("constructs EnvFileNotFoundError with option context", () => {
    const error = new EnvFileNotFoundError("--use-dotenvx", ".env.secrets");

    expectErrorIdentity(error, EnvFileNotFoundError);
    expect(error).toMatchObject({
      message: "Environment file not found",
      option: "--use-dotenvx",
      envFile: ".env.secrets",
    });
  });

  it("constructs ConfigValidationError with validation context", () => {
    const error = new ConfigValidationError(
      "composePath",
      ".rfapps.yaml",
      "Missing required field",
    );

    expectErrorIdentity(error, ConfigValidationError);
    expect(error).toMatchObject({
      message: "Invalid configuration: Missing required field",
      field: "composePath",
      configSource: ".rfapps.yaml",
      reason: "Missing required field",
    });
  });

  it("constructs ComposeFileParseError with parse context", () => {
    const error = new ComposeFileParseError("compose.yml", "Invalid YAML");

    expectErrorIdentity(error, ComposeFileParseError);
    expect(error).toMatchObject({
      message: "Failed to parse compose file: Invalid YAML",
      composePath: "compose.yml",
      reason: "Invalid YAML",
    });
  });

  it("constructs DockerCommandError with command context", () => {
    const services = ["plex", "traefik"];
    const error = new DockerCommandError("pull", "network timeout", 137, services, true);

    expectErrorIdentity(error, DockerCommandError);
    expect(error).toMatchObject({
      message: "Docker pull failed for plex, traefik",
      operation: "pull",
      stderr: "network timeout",
      exitCode: 137,
      services,
      isSSH: true,
    });
    expect(new DockerCommandError("stop", "", 1, ["plex"], false).message).toBe(
      "Docker stop failed for plex",
    );
  });

  it("constructs ImagePullError with pull context", () => {
    const services = ["plex", "sonarr"];
    const error = new ImagePullError(services, "network error");

    expectErrorIdentity(error, ImagePullError);
    expect(error).toMatchObject({
      message: "Failed to pull images for plex, sonarr",
      services,
      stderr: "network error",
    });
  });

  it("constructs ServiceStartError with start context", () => {
    const services = ["plex", "sonarr"];
    const error = new ServiceStartError(services, "port conflict");

    expectErrorIdentity(error, ServiceStartError);
    expect(error).toMatchObject({
      message: "Failed to start services: plex, sonarr",
      services,
      stderr: "port conflict",
    });
  });

  it("constructs DeploymentNotFoundError with deployment identity", () => {
    const error = new DeploymentNotFoundError("deploy-123", "plex");

    expectErrorIdentity(error, DeploymentNotFoundError);
    expect(error).toMatchObject({
      message: "Deployment 'deploy-123' not found for service 'plex'",
      deploymentId: "deploy-123",
      service: "plex",
    });
  });

  it("constructs InsufficientHistoryError with rollback context", () => {
    const error = new InsufficientHistoryError("plex", 5, 0);

    expectErrorIdentity(error, InsufficientHistoryError);
    expect(error).toMatchObject({
      message: "Insufficient rollback history for 'plex'",
      service: "plex",
      requestedSteps: 5,
      availableSteps: 0,
    });
  });

  it("constructs GenerationNotFoundError with selection criteria", () => {
    const error = new GenerationNotFoundError("plex", "generation 5");

    expectErrorIdentity(error, GenerationNotFoundError);
    expect(error).toMatchObject({
      message: "No generation found for service 'plex' matching generation 5",
      service: "plex",
      criteria: "generation 5",
    });
  });

  it("constructs PlanValidationError with plan context", () => {
    const error = new PlanValidationError("/path/to/plan.json", "Plan is stale");

    expectErrorIdentity(error, PlanValidationError);
    expect(error).toMatchObject({
      message: "Plan validation failed: Plan is stale",
      planPath: "/path/to/plan.json",
      reason: "Plan is stale",
    });
  });

  it("constructs InvalidArgumentError with optional valid values", () => {
    const validValues = ["json", "yaml", "csv"];
    const error = new InvalidArgumentError("--output", "xml", "Invalid output format", validValues);

    expectErrorIdentity(error, InvalidArgumentError);
    expect(error).toMatchObject({
      message: "Invalid value 'xml' for --output: Invalid output format",
      argument: "--output",
      value: "xml",
      reason: "Invalid output format",
      validValues,
    });
    expect(
      new InvalidArgumentError("--debug", "yes", "Must be a boolean").validValues,
    ).toBeUndefined();
  });

  it("constructs TagSelectorEmptyError with tag selection context", () => {
    const patterns = ["media/automaton"];
    const baseSelectors = ["--group arr-stack"];
    const knownTags = ["media/automation", "media/streaming"];
    const error = new TagSelectorEmptyError(
      patterns,
      baseSelectors,
      knownTags,
      "media/automation",
      ["plex-old"],
    );

    expectErrorIdentity(error, TagSelectorEmptyError);
    expect(error).toMatchObject({
      message: "Tag selector matched no services: media/automaton",
      patterns,
      baseSelectors,
      knownTags,
      suggestion: "media/automation",
      unresolvedServices: ["plex-old"],
    });

    const minimal = new TagSelectorEmptyError(["a/b", "c/**"], [], []);
    expect(minimal.message).toBe("Tag selector matched no services: a/b, c/**");
    expect(minimal.suggestion).toBeUndefined();
    expect(minimal.unresolvedServices).toEqual([]);
  });
});
