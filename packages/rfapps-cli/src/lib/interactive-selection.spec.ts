import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveServicesWithInteractive } from "./interactive-selection.js";
import * as interactiveCheck from "./interactive-check.js";
import * as interactive from "./interactive.js";
import * as services from "./services.js";
import * as validation from "./validation.js";
import * as tagIndexModule from "./tags/tag-index.js";
import * as common from "@rfmedia/common";
import type { RfappsConfig } from "../types/index.js";
import type { TagIndex, TagPath } from "../types/tags.js";
import {
  GroupNotFoundError,
  InvalidArgumentError,
  ServiceNotFoundError,
  TagSelectorEmptyError,
} from "./errors.js";
import { compareTags, normalizeTag, tagAncestors } from "./tags/tag-path.js";

// Mock dependencies
vi.mock("./interactive-check.js", () => ({
  shouldShowInteractiveSelection: vi.fn(),
}));

vi.mock("./interactive.js", () => ({
  selectServicesInteractive: vi.fn(),
}));

vi.mock("./services.js", () => ({
  expandServiceGroup: vi.fn(),
  getAvailableGroups: vi.fn(),
  expandServicesWithSidecars: vi.fn(),
  autoDetectProfiles: vi.fn(),
}));

vi.mock("./validation.js", () => ({
  validateServiceNames: vi.fn(),
  parseComposeFile: vi.fn(),
}));

// `getTagIndex` reaches the config layers and the filesystem, so it is stubbed and the tag
// tests run against a deterministic index fixture. `findClosestTag` is stubbed only so the
// diagnosis tests below can prove the resolver no longer calls it through this module —
// suggestions now come from the real `diagnoseEmptyTagSelection` in tag-suggestions.ts.
vi.mock("./tags/tag-index.js", () => ({
  getTagIndex: vi.fn(),
  findClosestTag: vi.fn(),
}));

// Only `findClosestMatch` (group suggestions) is stubbed. `computeSimilarity` stays real
// because the tag-suggestion path now runs for real through `diagnoseEmptyTagSelection`,
// and an automocked scorer would silently return undefined for every pattern.
vi.mock("./fuzzy-match.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fuzzy-match.js")>();

  return { ...actual, findClosestMatch: vi.fn() };
});

vi.mock("@rfmedia/common", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

/**
 * Builds a `TagIndex` literal from a declared mapping.
 *
 * Deliberately does NOT call `buildTagIndex` — `./tags/tag-index.js` is mocked above, and
 * an index fixture that depended on the module under stub would be circular. `normalizeTag`
 * still mints every `TagPath` so the branded type is never cast.
 */
function buildIndexFixture(
  mapping: Readonly<Record<string, readonly string[]>>,
  composeUniverse: readonly string[],
): TagIndex {
  const universeSet = new Set(composeUniverse);
  const ordered = [
    ...composeUniverse.filter((service) => mapping[service] !== undefined),
    ...Object.keys(mapping).filter((service) => !universeSet.has(service)),
  ];

  const declared = new Map<string, readonly TagPath[]>();
  const effective = new Map<string, ReadonlySet<TagPath>>();
  const byTag = new Map<TagPath, string[]>();
  const declaredTags = new Set<TagPath>();
  const unresolvedServices: string[] = [];

  for (const service of ordered) {
    if (!universeSet.has(service)) {
      unresolvedServices.push(service);
    }

    const tags = (mapping[service] ?? []).map((authored) => normalizeTag(authored));
    const closure = new Set<TagPath>();

    for (const tag of tags) {
      declaredTags.add(tag);
      for (const ancestor of tagAncestors(tag)) {
        closure.add(ancestor);
      }
    }

    declared.set(service, tags);
    effective.set(service, closure);

    for (const tag of closure) {
      const carriers = byTag.get(tag) ?? [];
      carriers.push(service);
      byTag.set(tag, carriers);
    }
  }

  return {
    declared,
    effective,
    byTag,
    allTags: [...byTag.keys()].sort(compareTags),
    declaredTags,
    unresolvedServices,
    source: "/repo/rfapps.config.yaml",
  };
}

describe("Interactive Selection", () => {
  // Sample configuration for testing
  const mockConfig: RfappsConfig = {
    composePath: "compose.yml",
    envFile: ".env",
    profiles: {
      defaultProfile: "core",
      validProfiles: ["core", "infrastructure", "downloads", "arr-stack", "media", "photos", "all"],
      mapping: {
        traefik: "core",
        plex: "media",
        sonarr: "arr-stack",
      },
    },
    sidecars: {
      enabled: true,
      mapping: {
        plex: "plex-ts",
      },
    },
    groups: {
      "media-stack": ["plex", "sonarr", "radarr"],
      "core-stack": ["traefik", "authentik-server"],
    },
    healthCheck: {
      timeout: 30,
      interval: 5,
      retries: 3,
      waitForReady: true,
    },
    envTool: {
      tool: "none",
    },
    docker: {},
    interactive: {
      pageSize: 10,
    },
    state: {
      enabled: true,
    },
    parallel: {
      enabled: false,
      workers: 4,
    },
  };

  const composePath = "/path/to/compose.yml";
  const projectDir = "/path/to/project";

  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock implementations
    vi.mocked(services.expandServicesWithSidecars).mockImplementation((svcs) => svcs);
    vi.mocked(services.autoDetectProfiles).mockReturnValue(["core"]);
    vi.mocked(services.getAvailableGroups).mockReturnValue(["media-stack", "core-stack"]);
  });

  describe("resolveServicesWithInteractive", () => {
    describe("when service targeting flags are provided", () => {
      it("should resolve single service (-s flag)", async () => {
        const options = { service: "traefik", noSidecars: true };

        const result = await resolveServicesWithInteractive(
          options,
          mockConfig,
          composePath,
          projectDir,
        );

        expect(result).not.toBeNull();
        expect(result?.services).toEqual(["traefik"]);
        expect(result?.preSidecarCount).toBe(1);
        expect(result?.sidecarsExpanded).toBe(false);
        expect(interactive.selectServicesInteractive).not.toHaveBeenCalled();
      });

      it("should resolve multiple services (--services flag)", async () => {
        const options = { services: ["traefik", "plex"], noSidecars: true };

        const result = await resolveServicesWithInteractive(
          options,
          mockConfig,
          composePath,
          projectDir,
        );

        expect(result).not.toBeNull();
        expect(result?.services).toEqual(["traefik", "plex"]);
        expect(result?.preSidecarCount).toBe(2);
        expect(result?.sidecarsExpanded).toBe(false);
        expect(interactive.selectServicesInteractive).not.toHaveBeenCalled();
      });

      it("should resolve service group (-g flag)", async () => {
        vi.mocked(services.expandServiceGroup).mockReturnValue(["plex", "sonarr", "radarr"]);
        const options = { group: "media-stack", noSidecars: true };

        const result = await resolveServicesWithInteractive(
          options,
          mockConfig,
          composePath,
          projectDir,
        );

        expect(result).not.toBeNull();
        expect(result?.services).toEqual(["plex", "sonarr", "radarr"]);
        expect(result?.preSidecarCount).toBe(3);
        expect(result?.sidecarsExpanded).toBe(false);
        expect(services.expandServiceGroup).toHaveBeenCalledWith("media-stack", mockConfig);
        expect(interactive.selectServicesInteractive).not.toHaveBeenCalled();
      });

      it("should throw GroupNotFoundError for unknown group", async () => {
        vi.mocked(services.expandServiceGroup).mockReturnValue(undefined);
        const options = { group: "unknown-group", noSidecars: true };

        await expect(
          resolveServicesWithInteractive(options, mockConfig, composePath, projectDir),
        ).rejects.toThrow(GroupNotFoundError);

        try {
          await resolveServicesWithInteractive(options, mockConfig, composePath, projectDir);
        } catch (error) {
          expect(error).toBeInstanceOf(GroupNotFoundError);
          const groupError = error as GroupNotFoundError;
          expect(groupError.groupName).toBe("unknown-group");
          expect(groupError.availableGroups).toEqual(["media-stack", "core-stack"]);
        }
      });

      it("should combine service and services flags", async () => {
        const options = {
          service: "traefik",
          services: ["plex", "sonarr"],
          noSidecars: true,
        };

        const result = await resolveServicesWithInteractive(
          options,
          mockConfig,
          composePath,
          projectDir,
        );

        expect(result).not.toBeNull();
        expect(result?.services).toEqual(["traefik", "plex", "sonarr"]);
        expect(result?.preSidecarCount).toBe(3);
        expect(result?.sidecarsExpanded).toBe(false);
      });

      it("should combine group and service flags", async () => {
        vi.mocked(services.expandServiceGroup).mockReturnValue(["plex", "sonarr", "radarr"]);
        const options = {
          group: "media-stack",
          service: "traefik",
          noSidecars: true,
        };

        const result = await resolveServicesWithInteractive(
          options,
          mockConfig,
          composePath,
          projectDir,
        );

        expect(result).not.toBeNull();
        expect(result?.services).toContain("traefik");
        expect(result?.services).toContain("plex");
        expect(result?.preSidecarCount).toBe(4);
        expect(result?.sidecarsExpanded).toBe(false);
      });

      it("should deduplicate services when group and individual services overlap", async () => {
        vi.mocked(services.expandServiceGroup).mockReturnValue(["plex", "sonarr", "radarr"]);
        const options = {
          group: "media-stack",
          service: "plex",
          services: ["sonarr"],
          noSidecars: true,
        };

        const result = await resolveServicesWithInteractive(
          options,
          mockConfig,
          composePath,
          projectDir,
        );

        expect(result).not.toBeNull();
        // Should only contain each service once despite overlaps
        expect(result?.services).toEqual(["plex", "sonarr", "radarr"]);
        expect(result?.preSidecarCount).toBe(3);
        expect(result?.sidecarsExpanded).toBe(false);
      });
    });

    describe("when interactive selection should be shown", () => {
      beforeEach(() => {
        vi.mocked(interactiveCheck.shouldShowInteractiveSelection).mockReturnValue(true);
      });

      it("should return selected services from interactive UI", async () => {
        vi.mocked(interactive.selectServicesInteractive).mockResolvedValue(["plex", "sonarr"]);
        const options = { noSidecars: true };

        const result = await resolveServicesWithInteractive(
          options,
          mockConfig,
          composePath,
          projectDir,
        );

        expect(result).not.toBeNull();
        expect(result?.services).toEqual(["plex", "sonarr"]);
        expect(result?.preSidecarCount).toBe(2);
        expect(result?.sidecarsExpanded).toBe(false);
        expect(interactive.selectServicesInteractive).toHaveBeenCalledWith(
          composePath,
          projectDir,
          { envTool: undefined, pageSize: 10 },
        );
      });

      it("should return null when user cancels selection (Escape)", async () => {
        vi.mocked(interactive.selectServicesInteractive).mockResolvedValue(null);
        const options = { noSidecars: true };

        const result = await resolveServicesWithInteractive(
          options,
          mockConfig,
          composePath,
          projectDir,
        );

        expect(result).toBeNull();
        expect(common.logInfo).toHaveBeenCalledWith("Selection cancelled");
      });

      it("should return null when user confirms with no selection", async () => {
        vi.mocked(interactive.selectServicesInteractive).mockResolvedValue([]);
        const options = { noSidecars: true };

        const result = await resolveServicesWithInteractive(
          options,
          mockConfig,
          composePath,
          projectDir,
        );

        expect(result).toBeNull();
        expect(common.logInfo).toHaveBeenCalledWith("No services selected");
      });
    });

    describe("when not in interactive mode", () => {
      beforeEach(() => {
        vi.mocked(interactiveCheck.shouldShowInteractiveSelection).mockReturnValue(false);
      });

      it("should return empty services array (means all services)", async () => {
        const options = { noSidecars: true };

        const result = await resolveServicesWithInteractive(
          options,
          mockConfig,
          composePath,
          projectDir,
        );

        expect(result).not.toBeNull();
        expect(result?.services).toEqual([]);
        expect(result?.preSidecarCount).toBe(0);
        expect(result?.sidecarsExpanded).toBe(false);
        expect(interactive.selectServicesInteractive).not.toHaveBeenCalled();
      });

      it("should use default profile when services array is empty", async () => {
        const options = { noSidecars: true };

        const result = await resolveServicesWithInteractive(
          options,
          mockConfig,
          composePath,
          projectDir,
        );

        expect(result).not.toBeNull();
        expect(result?.profiles).toEqual(["core"]); // defaultProfile from mockConfig
        expect(services.autoDetectProfiles).not.toHaveBeenCalled();
      });
    });

    describe("sidecar expansion", () => {
      it("should apply sidecar expansion when sidecars enabled", async () => {
        vi.mocked(services.expandServicesWithSidecars).mockReturnValue(["plex", "plex-ts"]);
        const options = { service: "plex", noSidecars: false };

        // Create config with sidecars enabled
        const configWithSidecars = {
          ...mockConfig,
          sidecars: { ...mockConfig.sidecars, enabled: true },
        };

        const result = await resolveServicesWithInteractive(
          options,
          configWithSidecars,
          composePath,
          projectDir,
        );

        expect(result).not.toBeNull();
        expect(services.expandServicesWithSidecars).toHaveBeenCalledWith(
          ["plex"],
          configWithSidecars,
        );
        expect(result?.services).toEqual(["plex", "plex-ts"]);
        expect(result?.preSidecarCount).toBe(1);
        expect(result?.sidecarsExpanded).toBe(true);
      });

      it("should not apply sidecar expansion when --no-sidecars is set", async () => {
        const options = { service: "plex", noSidecars: true };

        const result = await resolveServicesWithInteractive(
          options,
          mockConfig,
          composePath,
          projectDir,
        );

        expect(result).not.toBeNull();
        expect(services.expandServicesWithSidecars).not.toHaveBeenCalled();
        expect(result?.services).toEqual(["plex"]);
        expect(result?.preSidecarCount).toBe(1);
        expect(result?.sidecarsExpanded).toBe(false);
      });

      it("should not apply sidecar expansion when sidecars=false (Commander pattern)", async () => {
        // Commander.js sets sidecars=false when --no-sidecars is passed
        const options = { service: "plex", noSidecars: false, sidecars: false };

        const result = await resolveServicesWithInteractive(
          options,
          mockConfig,
          composePath,
          projectDir,
        );

        expect(result).not.toBeNull();
        expect(services.expandServicesWithSidecars).not.toHaveBeenCalled();
        expect(result?.services).toEqual(["plex"]);
        expect(result?.preSidecarCount).toBe(1);
        expect(result?.sidecarsExpanded).toBe(false);
      });

      it("should not apply sidecar expansion when config disables sidecars", async () => {
        const configSidecarsDisabled = {
          ...mockConfig,
          sidecars: { ...mockConfig.sidecars, enabled: false },
        };
        const options = { service: "plex", noSidecars: false };

        const result = await resolveServicesWithInteractive(
          options,
          configSidecarsDisabled,
          composePath,
          projectDir,
        );

        expect(result).not.toBeNull();
        expect(services.expandServicesWithSidecars).not.toHaveBeenCalled();
        expect(result?.preSidecarCount).toBe(1);
        expect(result?.sidecarsExpanded).toBe(false);
      });

      it("should not apply sidecar expansion for empty services array", async () => {
        vi.mocked(interactiveCheck.shouldShowInteractiveSelection).mockReturnValue(false);
        const options = { noSidecars: false };

        const result = await resolveServicesWithInteractive(
          options,
          mockConfig,
          composePath,
          projectDir,
        );

        expect(result).not.toBeNull();
        // Sidecar expansion only happens when services.length > 0
        expect(services.expandServicesWithSidecars).not.toHaveBeenCalled();
        expect(result?.preSidecarCount).toBe(0);
        expect(result?.sidecarsExpanded).toBe(false);
      });
    });

    describe("profile auto-detection", () => {
      it("should auto-detect profiles when services are specified", async () => {
        vi.mocked(services.autoDetectProfiles).mockReturnValue(["media", "arr-stack"]);
        const options = { services: ["plex", "sonarr"], noSidecars: true };

        const result = await resolveServicesWithInteractive(
          options,
          mockConfig,
          composePath,
          projectDir,
        );

        expect(result).not.toBeNull();
        expect(services.autoDetectProfiles).toHaveBeenCalledWith(["plex", "sonarr"], mockConfig);
        expect(result?.profiles).toEqual(["media", "arr-stack"]);
      });

      it("should use default profile when services array is empty", async () => {
        vi.mocked(interactiveCheck.shouldShowInteractiveSelection).mockReturnValue(false);
        const options = { noSidecars: true };

        const result = await resolveServicesWithInteractive(
          options,
          mockConfig,
          composePath,
          projectDir,
        );

        expect(result).not.toBeNull();
        expect(result?.profiles).toEqual(["core"]); // defaultProfile
      });

      it("should auto-detect profiles after sidecar expansion", async () => {
        vi.mocked(services.expandServicesWithSidecars).mockReturnValue(["plex", "plex-ts"]);
        vi.mocked(services.autoDetectProfiles).mockReturnValue(["media"]);
        const options = { service: "plex", noSidecars: false };

        const result = await resolveServicesWithInteractive(
          options,
          mockConfig,
          composePath,
          projectDir,
        );

        expect(result).not.toBeNull();
        // autoDetectProfiles should be called with expanded services
        expect(services.autoDetectProfiles).toHaveBeenCalledWith(["plex", "plex-ts"], mockConfig);
      });
    });

    describe("edge cases", () => {
      it("should handle --yes flag with no service flags (non-interactive, all services)", async () => {
        vi.mocked(interactiveCheck.shouldShowInteractiveSelection).mockReturnValue(false);
        const options = { yes: true, noSidecars: true };

        const result = await resolveServicesWithInteractive(
          options,
          mockConfig,
          composePath,
          projectDir,
        );

        expect(result).not.toBeNull();
        expect(result?.services).toEqual([]);
        expect(result?.preSidecarCount).toBe(0);
        expect(result?.sidecarsExpanded).toBe(false);
        expect(interactive.selectServicesInteractive).not.toHaveBeenCalled();
      });

      // A supplied-but-empty `--services` is NOT "no flag": it must never decay into
      // interactive selection either, or `rfapps import --services ""` would present the
      // whole fleet for adoption instead of reporting the operator's typo.
      it("rejects a supplied-but-empty services array instead of prompting", async () => {
        const options = { services: [], noSidecars: true };
        vi.mocked(interactiveCheck.shouldShowInteractiveSelection).mockReturnValue(true);
        vi.mocked(interactive.selectServicesInteractive).mockResolvedValue(["plex"]);

        await expect(
          resolveServicesWithInteractive(options, mockConfig, composePath, projectDir),
        ).rejects.toBeInstanceOf(InvalidArgumentError);

        expect(interactive.selectServicesInteractive).not.toHaveBeenCalled();
      });
    });

    describe("--services that denotes no service fails closed", () => {
      // Most actions reach the resolver via `rawOptions.services?.split(",")`, which yields
      // the first three arrays for `--services ""`, `--services ","` and `--services "  "`.
      // `import`, `reconcile`, `update` and `backup` additionally strip empty entries, so
      // for them the SAME operator input arrives as `[]`. Every one of these must be
      // rejected: resolving them would hand callers the "no explicit target" sentinel and
      // make `rfapps delete --services "" --yes` operate on the whole project.
      it.each([
        ['--services ""', [""]],
        ['--services ","', ["", ""]],
        ['--services "  "', ["  "]],
        ['--services "" through an empty-filtering action', []],
      ])("rejects %s instead of resolving to the whole project", async (_label, services) => {
        vi.mocked(interactiveCheck.shouldShowInteractiveSelection).mockReturnValue(false);
        const options = { services, yes: true, noSidecars: true };

        let resolved: Awaited<ReturnType<typeof resolveServicesWithInteractive>> | undefined;
        let caught: unknown;

        try {
          resolved = await resolveServicesWithInteractive(
            options,
            mockConfig,
            composePath,
            projectDir,
          );
        } catch (error) {
          caught = error;
        }

        expect(resolved).toBeUndefined();
        expect(caught).toBeInstanceOf(InvalidArgumentError);
        expect((caught as InvalidArgumentError).argument).toBe("--services");
        // Whitespace-only and empty inputs are invisible once re-joined, so the message
        // echoes what the resolver actually received instead of collapsing all four to ''.
        expect((caught as InvalidArgumentError).value).toBe(JSON.stringify(services));
        expect(validation.validateServiceNames).not.toHaveBeenCalled();
      });

      it("still resolves a --services value that names a service", async () => {
        const options = { services: ["traefik"], yes: true, noSidecars: true };

        const result = await resolveServicesWithInteractive(
          options,
          mockConfig,
          composePath,
          projectDir,
        );

        expect(result?.services).toEqual(["traefik"]);
      });
    });

    describe("error handling", () => {
      it("should handle interactive selection throwing an error", async () => {
        vi.mocked(interactiveCheck.shouldShowInteractiveSelection).mockReturnValue(true);
        vi.mocked(interactive.selectServicesInteractive).mockRejectedValue(
          new Error("Docker daemon not available"),
        );
        const options = { noSidecars: true };

        // The function should propagate the error or handle it gracefully
        await expect(
          resolveServicesWithInteractive(options, mockConfig, composePath, projectDir),
        ).rejects.toThrow("Docker daemon not available");
      });

      it("should handle sidecar expansion throwing an error", async () => {
        vi.mocked(services.expandServicesWithSidecars).mockImplementation(() => {
          throw new Error("Invalid sidecar configuration");
        });
        const options = { service: "plex", noSidecars: false };

        await expect(
          resolveServicesWithInteractive(options, mockConfig, composePath, projectDir),
        ).rejects.toThrow("Invalid sidecar configuration");
      });

      it("should handle autoDetectProfiles returning empty array", async () => {
        vi.mocked(services.autoDetectProfiles).mockReturnValue([]);
        const options = { services: ["unknown-service"], noSidecars: true };

        const result = await resolveServicesWithInteractive(
          options,
          mockConfig,
          composePath,
          projectDir,
        );

        expect(result).not.toBeNull();
        expect(result?.profiles).toEqual([]);
      });

      it("should handle whitespace-only service names", async () => {
        const options = { service: "   ", noSidecars: true };

        const result = await resolveServicesWithInteractive(
          options,
          mockConfig,
          composePath,
          projectDir,
        );

        // Should include the whitespace service (validation happens elsewhere)
        expect(result).not.toBeNull();
        expect(result?.services).toEqual(["   "]);
      });

      it("should handle special characters in service names", async () => {
        const options = {
          services: ["service-with-dash", "service_with_underscore"],
          noSidecars: true,
        };

        const result = await resolveServicesWithInteractive(
          options,
          mockConfig,
          composePath,
          projectDir,
        );

        expect(result).not.toBeNull();
        expect(result?.services).toEqual(["service-with-dash", "service_with_underscore"]);
      });

      it("should handle undefined config gracefully", async () => {
        const options = { service: "traefik", noSidecars: true };
        const incompleteConfig = {
          ...mockConfig,
          profiles: undefined,
        } as unknown as RfappsConfig;

        // This tests resilience to malformed config
        const result = await resolveServicesWithInteractive(
          options,
          incompleteConfig,
          composePath,
          projectDir,
        );

        expect(result).not.toBeNull();
        expect(result?.services).toEqual(["traefik"]);
      });

      it("should handle null compose path", async () => {
        vi.mocked(interactiveCheck.shouldShowInteractiveSelection).mockReturnValue(true);
        vi.mocked(interactive.selectServicesInteractive).mockResolvedValue(null);
        const options = { noSidecars: true };

        // Pass null as compose path - should be handled
        const result = await resolveServicesWithInteractive(
          options,
          mockConfig,
          null as unknown as string,
          projectDir,
        );

        // The function should call selectServicesInteractive with the null path
        expect(interactive.selectServicesInteractive).toHaveBeenCalledWith(
          null,
          projectDir,
          expect.any(Object),
        );
        // Result should be null since interactive selection returns null
        expect(result).toBeNull();
      });
    });

    describe("--tag axis (design §7.2 post-conditions)", () => {
      const universe = ["traefik", "authentik-server", "plex", "sonarr", "radarr"];
      const tagIndex = buildIndexFixture(
        {
          traefik: ["infrastructure/core/networking"],
          "authentik-server": ["infrastructure/core/auth"],
          plex: ["media/streaming"],
          sonarr: ["media/automation"],
          radarr: ["media/automation"],
        },
        universe,
      );

      beforeEach(() => {
        // `vi.clearAllMocks()` clears calls but keeps implementations, so every stub these
        // tests set must be re-established here rather than relying on a pristine mock.
        vi.mocked(validation.validateServiceNames).mockResolvedValue(undefined);
        vi.mocked(validation.parseComposeFile).mockResolvedValue([...universe]);
        vi.mocked(tagIndexModule.getTagIndex).mockResolvedValue(tagIndex);
        vi.mocked(tagIndexModule.findClosestTag).mockReturnValue(undefined);
      });

      describe("P1 — backward compatibility is structural", () => {
        it("builds no tag index and reads no compose file when --tag is absent", async () => {
          const options = { service: "traefik", noSidecars: true };

          const result = await resolveServicesWithInteractive(
            options,
            mockConfig,
            composePath,
            projectDir,
          );

          expect(result?.services).toEqual(["traefik"]);
          expect(tagIndexModule.getTagIndex).not.toHaveBeenCalled();
          expect(validation.parseComposeFile).not.toHaveBeenCalled();
        });

        it("builds no tag index and reads no compose file when --tag is an empty array", async () => {
          vi.mocked(interactiveCheck.shouldShowInteractiveSelection).mockReturnValue(false);
          const options = { tag: [], noSidecars: true };

          const result = await resolveServicesWithInteractive(
            options,
            mockConfig,
            composePath,
            projectDir,
          );

          expect(result?.services).toEqual([]);
          expect(tagIndexModule.getTagIndex).not.toHaveBeenCalled();
          expect(validation.parseComposeFile).not.toHaveBeenCalled();
        });
      });

      describe("intersection, not union", () => {
        it("narrows the whole compose universe when --tag is the only selector", async () => {
          const options = { tag: ["media/**"], noSidecars: true };

          const result = await resolveServicesWithInteractive(
            options,
            mockConfig,
            composePath,
            projectDir,
          );

          expect(result?.services).toEqual(["plex", "sonarr", "radarr"]);
          expect(interactive.selectServicesInteractive).not.toHaveBeenCalled();
        });

        it("INTERSECTS --tag with -g rather than unioning", async () => {
          vi.mocked(services.expandServiceGroup).mockReturnValue(["plex", "sonarr", "radarr"]);
          const options = {
            group: "media-stack",
            tag: ["media/automation"],
            noSidecars: true,
          };

          const result = await resolveServicesWithInteractive(
            options,
            mockConfig,
            composePath,
            projectDir,
          );

          // Union would have kept plex (group member) and added nothing useful.
          expect(result?.services).toEqual(["sonarr", "radarr"]);
        });

        it("INTERSECTS --tag with -s rather than unioning", async () => {
          const options = { service: "plex", tag: ["media/**"], noSidecars: true };

          const result = await resolveServicesWithInteractive(
            options,
            mockConfig,
            composePath,
            projectDir,
          );

          expect(result?.services).toEqual(["plex"]);
        });

        it("ANDs multiple --tag occurrences", async () => {
          const options = { tag: ["media/**", "!media/automation"], noSidecars: true };

          const result = await resolveServicesWithInteractive(
            options,
            mockConfig,
            composePath,
            projectDir,
          );

          expect(result?.services).toEqual(["plex"]);
        });
      });

      describe("P2 — the [] sentinel is never reachable through the tag path", () => {
        it("throws TagSelectorEmptyError instead of returning [] when nothing matches", async () => {
          const options = { tag: ["hardware/**"], noSidecars: true };

          await expect(
            resolveServicesWithInteractive(options, mockConfig, composePath, projectDir),
          ).rejects.toThrow(TagSelectorEmptyError);
        });

        it("never resolves to the whole project when a tag narrows a group to nothing", async () => {
          vi.mocked(services.expandServiceGroup).mockReturnValue(["plex", "sonarr", "radarr"]);
          const options = {
            group: "media-stack",
            tag: ["hardware/**"],
            noSidecars: true,
          };

          let resolved: Awaited<ReturnType<typeof resolveServicesWithInteractive>> | undefined;
          let caught: unknown;

          try {
            resolved = await resolveServicesWithInteractive(
              options,
              mockConfig,
              composePath,
              projectDir,
            );
          } catch (error) {
            caught = error;
          }

          // The critical assertion: no result at all, rather than a `[]` that Compose
          // would read as "operate on the whole project".
          expect(resolved).toBeUndefined();
          expect(caught).toBeInstanceOf(TagSelectorEmptyError);

          const tagError = caught as TagSelectorEmptyError;
          expect(tagError.patterns).toEqual(["hardware/**"]);
          expect(tagError.baseSelectors).toEqual(["--group"]);
          expect(tagError.knownTags).toContain("media/streaming");
        });

        it("propagates InvalidArgumentError for a malformed pattern", async () => {
          const options = { tag: ["infrastructure/*"], noSidecars: true };

          await expect(
            resolveServicesWithInteractive(options, mockConfig, composePath, projectDir),
          ).rejects.toThrow(InvalidArgumentError);
        });
      });

      describe("P3 — BASE names are validated before the tag intersection", () => {
        it("throws ServiceNotFoundError for a misspelled -s even when --tag is present", async () => {
          vi.mocked(validation.validateServiceNames).mockRejectedValueOnce(
            new ServiceNotFoundError("plexx", [...universe], "plex"),
          );
          const options = { service: "plexx", tag: ["media/**"], noSidecars: true };

          let caught: unknown;

          try {
            await resolveServicesWithInteractive(options, mockConfig, composePath, projectDir);
          } catch (error) {
            caught = error;
          }

          expect(caught).toBeInstanceOf(ServiceNotFoundError);
          // Mechanical proof of the ordering: the tag axis never ran.
          expect(validation.parseComposeFile).not.toHaveBeenCalled();
          expect(tagIndexModule.getTagIndex).not.toHaveBeenCalled();
        });
      });

      describe("P4 — stale tags.mapping entries are named, not swallowed", () => {
        it("passes unresolvedServices into TagSelectorEmptyError", async () => {
          vi.mocked(tagIndexModule.getTagIndex).mockResolvedValue(
            buildIndexFixture(
              { plex: ["media/streaming"], "retired-service": ["hardware/gpu"] },
              universe,
            ),
          );
          const options = { tag: ["hardware/**"], noSidecars: true };

          let caught: unknown;

          try {
            await resolveServicesWithInteractive(options, mockConfig, composePath, projectDir);
          } catch (error) {
            caught = error;
          }

          expect(caught).toBeInstanceOf(TagSelectorEmptyError);
          expect((caught as TagSelectorEmptyError).unresolvedServices).toEqual(["retired-service"]);
        });
      });

      describe("the empty-selection diagnosis is accurate", () => {
        const staleIndex = buildIndexFixture(
          {
            traefik: ["infrastructure/core/networking"],
            plex: ["media/streaming"],
            sonarr: ["media/automation"],
            "retired-service": ["hardware/gpu"],
          },
          universe,
        );

        beforeEach(() => {
          vi.mocked(tagIndexModule.getTagIndex).mockResolvedValue(staleIndex);
          // A sentinel rather than `undefined`: the resolver must no longer route the
          // suggestion through this export at all. If the pre-fix
          // `findClosestTag(axis.terms[0].source)` call came back, every assertion below
          // would see this string instead of the real answer.
          vi.mocked(tagIndexModule.findClosestTag).mockReturnValue("SHOULD-NOT-BE-USED");
        });

        async function captureTagError(
          options: Parameters<typeof resolveServicesWithInteractive>[0],
        ): Promise<TagSelectorEmptyError> {
          let caught: unknown;

          try {
            await resolveServicesWithInteractive(options, mockConfig, composePath, projectDir);
          } catch (error) {
            caught = error;
          }

          expect(caught).toBeInstanceOf(TagSelectorEmptyError);

          return caught as TagSelectorEmptyError;
        }

        it("does not blame stale tags.mapping entries carrying unrelated tags", async () => {
          // `retired-service` carries only `hardware/gpu`, so "tags.mapping assigns THIS
          // tag to absent services" is simply false for a `media/**` typo — and passing
          // it through suppressed the fuzzy suggestion that was the real diagnosis.
          const error = await captureTagError({ tag: ["media/automaton"], noSidecars: true });

          expect(error.unresolvedServices).toEqual([]);
          expect(error.suggestion).toBe("media/automation");
        });

        it("still blames stale entries the patterns genuinely select", async () => {
          const error = await captureTagError({ tag: ["hardware/**"], noSidecars: true });

          expect(error.unresolvedServices).toEqual(["retired-service"]);
        });

        it("reports an empty INTERSECTION generically, not as a stale mapping", async () => {
          // `media/**` matches plex and sonarr; it is `-s traefik` that empties the
          // intersection, so the stale-mapping story would be doubly wrong here.
          const error = await captureTagError({
            service: "traefik",
            tag: ["media/**"],
            noSidecars: true,
          });

          expect(error.unresolvedServices).toEqual([]);
          expect(error.suggestion).toBeUndefined();
        });

        it("never suggests a tag the operator already typed correctly", async () => {
          const error = await captureTagError({
            service: "plex",
            tag: ["media/automation"],
            noSidecars: true,
          });

          // computeSimilarity("media/automation", "media/automation") === 1.0, so an
          // unconditional call scored the exact tag highest and echoed it back.
          expect(error.suggestion).toBeUndefined();
        });

        it("suggests for the misspelled term, not merely the first one", async () => {
          const error = await captureTagError({
            tag: ["media/**", "media/automaton"],
            noSidecars: true,
          });

          expect(error.suggestion).toBe("media/automation");
        });
      });

      describe("P6 — a tag-derived selection is indistinguishable downstream", () => {
        it("feeds the narrowed set to autoDetectProfiles", async () => {
          vi.mocked(services.autoDetectProfiles).mockReturnValue(["media"]);
          const options = { tag: ["media/**"], noSidecars: true };

          const result = await resolveServicesWithInteractive(
            options,
            mockConfig,
            composePath,
            projectDir,
          );

          expect(services.autoDetectProfiles).toHaveBeenCalledWith(
            ["plex", "sonarr", "radarr"],
            mockConfig,
          );
          expect(result?.profiles).toEqual(["media"]);
        });

        it("computes preSidecarCount from the post-intersection set", async () => {
          vi.mocked(services.expandServiceGroup).mockReturnValue(["plex", "sonarr", "radarr"]);
          const options = {
            group: "media-stack",
            tag: ["media/automation"],
            noSidecars: true,
          };

          const result = await resolveServicesWithInteractive(
            options,
            mockConfig,
            composePath,
            projectDir,
          );

          expect(result?.preSidecarCount).toBe(2);
          expect(result?.sidecarsExpanded).toBe(false);
        });

        it("expands sidecars from the post-intersection set", async () => {
          vi.mocked(services.expandServicesWithSidecars).mockReturnValue(["plex", "plex-ts"]);
          const options = { tag: ["media/streaming"], noSidecars: false };

          const result = await resolveServicesWithInteractive(
            options,
            mockConfig,
            composePath,
            projectDir,
          );

          expect(services.expandServicesWithSidecars).toHaveBeenCalledWith(["plex"], mockConfig);
          expect(result?.services).toEqual(["plex", "plex-ts"]);
          expect(result?.preSidecarCount).toBe(1);
          expect(result?.sidecarsExpanded).toBe(true);
        });
      });
    });
  });
});
