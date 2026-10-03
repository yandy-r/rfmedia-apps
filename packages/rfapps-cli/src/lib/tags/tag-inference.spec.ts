/**
 * Engine-level tests for the tag inference engine (design §11).
 *
 * Exactly four behaviors, deliberately: the never-mutates guarantee (the only
 * safety-critical property of an advisory surface), degraded mode, and the two
 * compose label shapes — the one branch in the whole feature where a real bug hides.
 *
 * `--out` handling lives in `src/actions/tag-suggest.ts` and is pinned by
 * `src/actions/tag-suggest.spec.ts`; it cannot be reached from here, because this
 * module has no filesystem surface at all.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";

import type { ComposeConfig } from "../docker.js";
import { getComposeConfig } from "../docker.js";
import type { TagInferenceComposeConfig } from "./tag-inference-rules.js";
import { normalizeTag, tagAncestors } from "./tag-path.js";
import type { TagInferenceOptions } from "./tag-inference.js";
import { inferTags } from "./tag-inference.js";
import type { RfappsConfig } from "../../types/config.js";
import type { TagIndex, TagPath } from "../../types/tags.js";

const fsSpies = vi.hoisted(() => ({
  writeFile: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: { ...actual, writeFile: fsSpies.writeFile },
    writeFile: fsSpies.writeFile,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: { ...actual, writeFileSync: fsSpies.writeFileSync },
    writeFileSync: fsSpies.writeFileSync,
  };
});

vi.mock("../docker.js", () => ({
  getComposeConfig: vi.fn(),
}));

const INDEX_SOURCE = "/srv/rfmedia-apps/rfapps.config.yaml";

const mockConfig: RfappsConfig = {
  composePath: "/srv/rfmedia-apps/compose.yml",
  envFile: "/srv/rfmedia-apps/.env",
  sidecars: { enabled: false, mapping: {} },
  groups: {
    "infra-stack": ["traefik"],
    "media-stack": ["plex"],
    "arr-stack": ["sonarr"],
  },
  profiles: {
    defaultProfile: "all",
    validProfiles: ["core", "infrastructure", "downloads", "arr-stack", "media", "photos", "all"],
    mapping: {
      traefik: "core",
      plex: "media",
      sonarr: "arr-stack",
      "authentik-redis": "core",
    },
  },
  healthCheck: { timeout: 30, interval: 5, retries: 3, waitForReady: true },
  envTool: { tool: "none" },
  docker: {},
  interactive: { pageSize: 10 },
  state: { enabled: true },
  parallel: { enabled: false, workers: 4 },
};

/**
 * Builds a `TagIndex` literal with real ancestor closure.
 *
 * Deliberately does not call the index builder: that module is written concurrently
 * in the same batch, and the engine takes the index as a parameter precisely so this
 * spec does not have to depend on it.
 */
function makeIndex(mapping: Readonly<Record<string, readonly string[]>> = {}): TagIndex {
  const declared = new Map<string, readonly TagPath[]>();
  const effective = new Map<string, ReadonlySet<TagPath>>();
  const byTag = new Map<TagPath, string[]>();
  const declaredTags = new Set<TagPath>();

  for (const [service, tags] of Object.entries(mapping)) {
    const normalized = tags.map((tag) => normalizeTag(tag));
    const closure = new Set<TagPath>();

    for (const tag of normalized) {
      declaredTags.add(tag);

      for (const ancestor of tagAncestors(tag)) {
        closure.add(ancestor);
        const carriers = byTag.get(ancestor) ?? [];

        if (!carriers.includes(service)) {
          carriers.push(service);
        }

        byTag.set(ancestor, carriers);
      }
    }

    declared.set(service, normalized);
    effective.set(service, closure);
  }

  return {
    declared,
    effective,
    byTag,
    allTags: [...byTag.keys()].sort(),
    declaredTags,
    unresolvedServices: [],
    source: INDEX_SOURCE,
  };
}

/** Casts a structural compose fixture the way the engine casts the real thing. */
function asComposeConfig(view: TagInferenceComposeConfig): ComposeConfig {
  return view as unknown as ComposeConfig;
}

const FULL_COMPOSE: TagInferenceComposeConfig = {
  services: {
    traefik: {
      image: "traefik:v3.1",
      labels: { "traefik.enable": "true" },
    },
    plex: {
      image: "lscr.io/linuxserver/plex:latest",
      labels: { "docktail.service.enable": "true", "docktail.service.port": "32400" },
    },
    sonarr: { image: "lscr.io/linuxserver/sonarr:develop" },
    "authentik-redis": { image: "redis:7-alpine" },
  },
};

const SCOPE = ["traefik", "plex", "sonarr", "authentik-redis"];

describe("tag-inference", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getComposeConfig).mockResolvedValue(asComposeConfig(FULL_COMPOSE));
  });

  describe("never mutates anything (design §8.1)", () => {
    it("should write nothing to the filesystem in default, --include-tagged, --rule, or degraded mode", async () => {
      // Guards the guard: if these bindings ever stop being the spies, the
      // "not.toHaveBeenCalled" assertions below would pass vacuously forever.
      expect(writeFile).toBe(fsSpies.writeFile);
      expect(writeFileSync).toBe(fsSpies.writeFileSync);

      const index = makeIndex({ plex: ["media/streaming"] });
      const modes: readonly TagInferenceOptions[] = [
        { services: SCOPE },
        { services: SCOPE, includeTagged: true },
        { services: SCOPE, rules: ["tag-infer-profile", "tag-infer-group"] },
      ];

      for (const mode of modes) {
        const result = await inferTags(mockConfig, index, mode);

        // Non-vacuity: each mode really did run and produce a fragment.
        expect(result.schemaVersion).toBe("tags.v1");
        expect(result.fragment).toContain("PASTE SOURCE");
      }

      vi.mocked(getComposeConfig).mockRejectedValue(new Error("spawn docker ENOENT"));
      const degradedResult = await inferTags(mockConfig, index, { services: SCOPE });

      expect(degradedResult.degraded).toBe(true);
      expect(degradedResult.fragment).toContain("PASTE SOURCE");

      expect(fsSpies.writeFile).not.toHaveBeenCalled();
      expect(fsSpies.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe("degraded mode (design §8.4)", () => {
    it("should report degraded: true with skippedRules and keep the config-only rules when getComposeConfig fails", async () => {
      vi.mocked(getComposeConfig).mockRejectedValue(new Error("spawn docker ENOENT"));

      const result = await inferTags(mockConfig, makeIndex(), { services: SCOPE });

      expect(result.degraded).toBe(true);
      expect(result.skippedRules).toEqual([
        "tag-infer-database",
        "tag-infer-cache",
        "tag-infer-ingress",
        "tag-infer-tailnet",
      ]);

      // The *arr name variant survives degradation; the label/image rules do not.
      const sonarr = result.proposals.find((proposal) => proposal.service === "sonarr");
      expect(sonarr?.tags).toContain("media/automation/arr");

      const traefik = result.proposals.find((proposal) => proposal.service === "traefik");
      expect(traefik?.tags).toContain("platform/core");
      expect(traefik?.tags).not.toContain("network/ingress");

      // A resolved-but-failed compose command degrades identically to a rejection.
      vi.mocked(getComposeConfig).mockResolvedValue(undefined);
      const undefinedResult = await inferTags(mockConfig, makeIndex(), { services: SCOPE });

      expect(undefinedResult.degraded).toBe(true);
      expect(undefinedResult.skippedRules).toEqual(result.skippedRules);
    });
  });

  describe("tag-infer-ingress label shapes (design §8.3)", () => {
    it("should fire on a traefik.enable label in MAP form", async () => {
      vi.mocked(getComposeConfig).mockResolvedValue(
        asComposeConfig({
          services: {
            whoami: {
              image: "traefik/whoami:latest",
              labels: { "traefik.enable": "true" },
            },
            metrics: { image: "prom/node-exporter:v1.8.2" },
          },
        }),
      );

      const result = await inferTags(mockConfig, makeIndex(), {
        services: ["whoami", "metrics"],
        rules: ["tag-infer-ingress"],
      });

      expect(result.degraded).toBe(false);
      expect(result.proposals).toHaveLength(1);
      expect(result.proposals[0]?.service).toBe("whoami");
      expect(result.proposals[0]?.tags).toEqual(["network/ingress"]);
      expect(result.proposals[0]?.rules).toEqual(["tag-infer-ingress"]);
      expect(result.proposals[0]?.confidence).toBe("high");
      expect(result.unresolved).toEqual(["metrics"]);
    });

    it("should fire on the same label in LIST form", async () => {
      vi.mocked(getComposeConfig).mockResolvedValue(
        asComposeConfig({
          services: {
            whoami: {
              image: "traefik/whoami:latest",
              labels: ["traefik.enable=true", "traefik.http.routers.whoami.entrypoints=websecure"],
            },
            metrics: { image: "prom/node-exporter:v1.8.2" },
          },
        }),
      );

      const result = await inferTags(mockConfig, makeIndex(), {
        services: ["whoami", "metrics"],
        rules: ["tag-infer-ingress"],
      });

      expect(result.degraded).toBe(false);
      expect(result.proposals).toHaveLength(1);
      expect(result.proposals[0]?.service).toBe("whoami");
      expect(result.proposals[0]?.tags).toEqual(["network/ingress"]);
      expect(result.proposals[0]?.rules).toEqual(["tag-infer-ingress"]);
      expect(result.unresolved).toEqual(["metrics"]);
    });
  });
});
