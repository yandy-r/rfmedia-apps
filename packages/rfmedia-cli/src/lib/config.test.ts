/**
 * Unit tests for config validation in config.ts.
 *
 * Tests cover validation of plex configuration sections:
 * - plex.defaultFilters (minPlays, excludeGenres, minRating, genre)
 * - plex.playlistDefaults (smart, updateExisting)
 * - plex.cache (enabled, ttlSeconds)
 * - plex.auth (mode, storePath, deviceName, refreshMarginSeconds)
 * - plex.pageSize, syncRatingsOnCopy, and syncOnCopyDefaults
 *
 * Since validation functions are internal, tests use the public validateConfig
 * function with plex configuration objects.
 *
 * IMPORTANT: Uses vi.clearAllMocks() in beforeEach(), NOT vi.resetAllMocks().
 * Using resetAllMocks() would reset mock implementations and break tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm, symlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

// Mock dependencies with vi.hoisted() - must be defined before vi.mock() calls
const mockFsPromises = vi.hoisted(() => ({
  stat: vi.fn(),
  readFile: vi.fn(),
}));

const mockLogger = vi.hoisted(() => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
}));

const mockFilesystem = vi.hoisted(() => ({
  pathExists: vi.fn().mockResolvedValue(false),
}));

const mockDb = vi.hoisted(() => ({
  getDefaultDatabasePath: vi.fn().mockReturnValue("/tmp/test.db"),
}));

// Apply mocks BEFORE importing the module under test
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  // Default stat and readFile to real implementations. Cache tests override these.
  mockFsPromises.stat.mockImplementation(actual.stat);
  mockFsPromises.readFile.mockImplementation(actual.readFile);
  return {
    ...actual,
    stat: mockFsPromises.stat,
    readFile: mockFsPromises.readFile,
  };
});
vi.mock("./logger.js", () => mockLogger);
vi.mock("./filesystem.js", () => mockFilesystem);
vi.mock("./db.js", () => mockDb);

// Import after mocks
import { validateConfig, getInteractiveConfig, loadConfig, mergeConfigs } from "./config.js";
import { ConfigError } from "./config-validation.js";
import { normalizeHttpUrl } from "./http-url.js";
import { clearConfigCache } from "./loaded-config.js";
import {
  formatError,
  outputFormattedError,
  SecretsInjectionError,
  setDebugMode,
} from "@rfmedia/common";
// Drift guard only: config.ts deliberately keeps a LOCAL rule-id set so the
// config slice stays independent of the policy type module. This test-only
// import is what stops the two lists diverging.
import { POLICY_RULE_IDS } from "../types/lidarr-policy.js";

describe("validateConfig", () => {
  const testConfigPath = "/test/config.yaml";

  beforeEach(() => {
    // Clear mocks but preserve implementations
    vi.clearAllMocks();
  });

  describe("copy conflict strategy validation", () => {
    it.each(["skip", "overwrite", "rename", "ask"] as const)(
      "retains copy.conflictStrategy %s",
      (conflictStrategy) => {
        const config = validateConfig({ copy: { conflictStrategy } }, testConfigPath);

        expect(config.copy?.conflictStrategy).toBe(conflictStrategy);
      },
    );

    it.each([
      { name: "unsupported string", value: "unsupported" },
      { name: "number", value: 42 },
      { name: "unstringifiable object", value: Object.create(null) },
    ])(
      "rejects invalid copy.conflictStrategy $name with the exact path",
      ({ value: conflictStrategy }) => {
        try {
          validateConfig({ copy: { conflictStrategy } }, testConfigPath);
          expect.unreachable("expected ConfigError");
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).propertyPath).toBe("copy.conflictStrategy");
        }
      },
    );
  });

  describe("plex URL validation", () => {
    it("accepts representative HTTP(S) loopback, LAN, and remote URLs", () => {
      for (const url of [
        "http://localhost:32400",
        "http://127.0.0.1:32400",
        "http://192.168.1.10:32400",
        "http://[::1]:32400",
        "https://plex.example.com",
      ]) {
        const config = validateConfig({ plex: { url } }, testConfigPath);

        expect(config.plex?.url, url).toBe(url);
      }
    });

    it("rejects malformed and unsupported URL equivalence classes", () => {
      for (const url of [
        "not a url",
        "ftp://plex.example.com",
        "file:///var/lib/plex",
        "http://",
      ]) {
        expect(() => validateConfig({ plex: { url } }, testConfigPath)).toThrow(
          `Invalid URL format for plex.url: ${url}. Must be http:// or https://`,
        );
      }
    });

    it("should preserve the existing non-empty URL type error", () => {
      expect(() => validateConfig({ plex: { url: "   " } }, testConfigPath)).toThrow(
        "Expected non-empty URL string for plex.url, got string",
      );
    });

    it("should expose canonical URL and origin values for connection resolution", () => {
      const result = normalizeHttpUrl("HTTP://PLEX.EXAMPLE.COM:80/library");

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("Expected the HTTP URL to normalize");
      }

      expect(result.value.href).toBe("http://plex.example.com/library");
      expect(result.value.origin).toBe("http://plex.example.com");
      expect(result.value.parsed.pathname).toBe("/library");
    });
  });

  // Issue #312 drift guards. These pin the exact message text of the primitives that
  // move to ./config-validation.js. Before this block, validateString,
  // validateStringArray, rejectUnknownConfigKeys and requireConfigObject had zero
  // message coverage, and three of the four raw `got ${value}` tails were ungated.
  describe("moved validation primitive message contracts", () => {
    it("pins validateBoolean's full message tail", () => {
      expect(() => validateConfig({ plex: { cache: { enabled: "yes" } } }, testConfigPath)).toThrow(
        "Expected boolean for plex.cache.enabled, got string",
      );
    });

    it("pins validatePositiveInteger's raw value tail", () => {
      expect(() => validateConfig({ lidarr: { timeoutMs: 0 } }, testConfigPath)).toThrow(
        "Expected positive integer for lidarr.timeoutMs, got 0",
      );
    });

    it("pins validateNonNegativeInteger's raw value tail", () => {
      expect(() =>
        validateConfig({ plex: { defaultFilters: { minPlays: -5 } } }, testConfigPath),
      ).toThrow("Expected non-negative integer for plex.defaultFilters.minPlays, got -5");
    });

    it("pins validateBoundedInteger's raw value tail", () => {
      expect(() =>
        validateConfig({ plex: { auth: { refreshMarginSeconds: 10 } } }, testConfigPath),
      ).toThrow("Expected integer between 60 and 86400 for plex.auth.refreshMarginSeconds, got 10");
    });

    it("pins validateStarRating's raw value tail", () => {
      expect(() =>
        validateConfig(
          { policy: { rules: { "rating-quality-upgrade": { minRating: 9 } } } },
          testConfigPath,
        ),
      ).toThrow(
        "Expected number between 1.0 and 5.0 for policy.rules.rating-quality-upgrade.minRating, got 9",
      );
    });

    it("pins validateString's message", () => {
      expect(() => validateConfig({ clean: { protect: 5 } }, testConfigPath)).toThrow(
        "Expected non-empty string for clean.protect, got number",
      );
    });

    it("pins validateStringArray's message", () => {
      expect(() => validateConfig({ clean: { exclude: 5 } }, testConfigPath)).toThrow(
        "Expected array of strings for clean.exclude",
      );
    });

    it("pins validateStringArray's empty-entry filtering contract", () => {
      const config = validateConfig({ clean: { exclude: ["a", " ", ""] } }, testConfigPath);

      expect(config.clean?.exclude).toEqual(["a"]);
    });

    it("pins rejectUnknownConfigKeys's message", () => {
      expect(() =>
        validateConfig({ policy: { rules: { "typo-rule": {} } } }, testConfigPath),
      ).toThrow("Unknown property policy.rules.typo-rule");
    });

    it("pins requireConfigObject's message at both call-site families", () => {
      expect(() => validateConfig({ policy: { rules: [] } }, testConfigPath)).toThrow(
        "Expected object for policy.rules, got array",
      );
      expect(() => validateConfig({ lidarr: { cascadeAnalysis: [] } }, testConfigPath)).toThrow(
        "Expected object for lidarr.cascadeAnalysis, got array",
      );
    });
  });

  describe("smart filter separation validation", () => {
    const rule = {
      type: "rule",
      field: "rating",
      operator: ">=",
      value: 3,
    };

    it("accepts and retains a complete separation policy", () => {
      const config = validateConfig(
        {
          filters: {
            radio: {
              match: "all",
              rules: [rule],
              separation: {
                artist: 5,
                genre: 3,
                tempo: "alternate",
                era: "distribute",
                energy: "wave",
              },
            },
          },
        },
        testConfigPath,
      );

      expect(config.filters?.["radio"]?.separation).toEqual({
        artist: 5,
        genre: 3,
        tempo: "alternate",
        era: "distribute",
        energy: "wave",
      });
    });

    it("leaves existing filters without separation unchanged", () => {
      const config = validateConfig(
        { filters: { liked: { match: "all", rules: [rule] } } },
        testConfigPath,
      );

      expect(config.filters?.["liked"]).toEqual({ match: "all", rules: [rule] });
    });

    it("rejects invalid separation gaps", () => {
      for (const [field, value] of [
        ["artist", 0],
        ["artist", 1.5],
        ["genre", 101],
        ["genre", "3"],
      ] as const) {
        expect(() =>
          validateConfig(
            {
              filters: {
                radio: {
                  match: "all",
                  rules: [rule],
                  separation: { [field]: value },
                },
              },
            },
            testConfigPath,
          ),
        ).toThrow(`filters.radio.separation.${field}`);
      }
    });

    it("rejects every unsupported separation mode", () => {
      for (const [field, value] of [
        ["tempo", "shuffle"],
        ["era", "cluster"],
        ["energy", "random"],
      ] as const) {
        expect(() =>
          validateConfig(
            {
              filters: {
                radio: {
                  match: "all",
                  rules: [rule],
                  separation: { [field]: value },
                },
              },
            },
            testConfigPath,
          ),
        ).toThrow(`filters.radio.separation.${field}`);
      }
    });

    it("rejects non-object and unknown separation values", () => {
      expect(() =>
        validateConfig(
          {
            filters: {
              radio: { match: "all", rules: [rule], separation: true },
            },
          },
          testConfigPath,
        ),
      ).toThrow("Expected object for filters.radio.separation");

      expect(() =>
        validateConfig(
          {
            filters: {
              radio: {
                match: "all",
                rules: [rule],
                separation: { album: 2 },
              },
            },
          },
          testConfigPath,
        ),
      ).toThrow("filters.radio.separation.album");
    });
  });

  describe("lidarr validation", () => {
    const makeConfiguredPresetPack = () => ({
      version: 1,
      description: "Studio-quality policy",
      assumptions: ["Requires FLAC quality support"],
      consequences: ["Future imports use the configured naming policy"],
      capabilities: [
        "custom-format-schema",
        "custom-format-create",
        "custom-format-update",
        "quality-profile-schema",
        "quality-profile-create",
        "quality-profile-update",
        "naming-read",
        "naming-examples",
        "naming-update",
      ],
      customFormats: [
        {
          name: "Studio Release",
          includeCustomFormatWhenRenaming: true,
          specifications: [
            {
              name: "Studio title",
              implementation: "ReleaseTitleSpecification",
              negate: false,
              required: true,
              fields: { value: "studio" },
            },
          ],
        },
      ],
      qualityProfiles: [
        {
          name: "Studio Lossless",
          upgradeAllowed: true,
          cutoff: "FLAC",
          items: [{ kind: "quality", name: "FLAC", allowed: true }],
          minFormatScore: 0,
          cutoffFormatScore: 100,
          formatScores: [{ customFormatName: "Studio Release", score: 100 }],
        },
      ],
      naming: {
        renameTracks: true,
        replaceIllegalCharacters: true,
        colonReplacementFormat: 4,
        standardTrackFormat: "{track:00} - {Track Title}",
        multiDiscTrackFormat: "{medium:00}-{track:00} - {Track Title}",
        artistFolderFormat: "{Artist Name}",
      },
    });

    const validateConfiguredPacks = (packs: Record<string, unknown>) =>
      validateConfig({ lidarr: { profilePresets: { packs } } }, testConfigPath);

    it("should accept a valid lidarr section", () => {
      const config = validateConfig(
        {
          lidarr: {
            baseUrl: "http://localhost:8686",
            apiKey: "secret-key",
            timeoutMs: 15000,
          },
        },
        testConfigPath,
      );

      expect(config.lidarr?.baseUrl).toBe("http://localhost:8686");
      expect(config.lidarr?.apiKey).toBe("secret-key");
      expect(config.lidarr?.timeoutMs).toBe(15000);
    });

    it("should reject a malformed lidarr.baseUrl", () => {
      expect(() =>
        validateConfig({ lidarr: { baseUrl: "ftp://lidarr.example.com" } }, testConfigPath),
      ).toThrow(
        "Invalid URL format for lidarr.baseUrl: ftp://lidarr.example.com. Must be http:// or https://",
      );
    });

    it("should reject a non-positive lidarr.timeoutMs", () => {
      expect(() => validateConfig({ lidarr: { timeoutMs: 0 } }, testConfigPath)).toThrow(
        "Expected positive integer for lidarr.timeoutMs, got 0",
      );
    });

    it("should reject a non-object lidarr section", () => {
      expect(() => validateConfig({ lidarr: "nope" }, testConfigPath)).toThrow(
        "lidarr must be an object",
      );
    });

    describe("lidarr.cascadeAnalysis validation", () => {
      const CASCADE_FIELDS = [
        { section: "budgets", field: "indexerQueries" },
        { section: "budgets", field: "acquisitionCandidates" },
        { section: "assumptions", field: "albumsPerArtist" },
        { section: "assumptions", field: "indexerQueriesPerCandidate" },
      ] as const;

      it("accepts omission, empty objects, and the complete bounded shape", () => {
        expect(
          validateConfig({ lidarr: {} }, testConfigPath).lidarr?.cascadeAnalysis,
        ).toBeUndefined();
        expect(
          validateConfig({ lidarr: { cascadeAnalysis: {} } }, testConfigPath).lidarr
            ?.cascadeAnalysis,
        ).toEqual({});

        const config = validateConfig(
          {
            lidarr: {
              cascadeAnalysis: {
                budgets: {
                  indexerQueries: 1,
                  acquisitionCandidates: 1_000_000,
                },
                assumptions: {
                  albumsPerArtist: 20,
                  indexerQueriesPerCandidate: 2,
                },
              },
            },
          },
          testConfigPath,
        );

        expect(config.lidarr?.cascadeAnalysis).toEqual({
          budgets: {
            indexerQueries: 1,
            acquisitionCandidates: 1_000_000,
          },
          assumptions: {
            albumsPerArtist: 20,
            indexerQueriesPerCandidate: 2,
          },
        });
      });

      it.each([
        [{ cascadeAnalysis: [] }, "lidarr.cascadeAnalysis"],
        [{ cascadeAnalysis: { budgets: [] } }, "lidarr.cascadeAnalysis.budgets"],
        [{ cascadeAnalysis: { assumptions: [] } }, "lidarr.cascadeAnalysis.assumptions"],
        [{ cascadeAnalysis: { unexpected: true } }, "lidarr.cascadeAnalysis.unexpected"],
        [
          { cascadeAnalysis: { budgets: { unexpected: 1 } } },
          "lidarr.cascadeAnalysis.budgets.unexpected",
        ],
        [
          { cascadeAnalysis: { assumptions: { unexpected: 1 } } },
          "lidarr.cascadeAnalysis.assumptions.unexpected",
        ],
      ])("rejects invalid or unknown nested shape at %s", (lidarr, propertyPath) => {
        expect(() => validateConfig({ lidarr }, testConfigPath)).toThrow(ConfigError);

        try {
          validateConfig({ lidarr }, testConfigPath);
          expect.fail("expected cascade analysis validation to fail");
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).propertyPath).toBe(propertyPath);
        }
      });

      it.each(CASCADE_FIELDS)(
        "rejects invalid $section / $field values with the exact path",
        ({ section, field }) => {
          const propertyPath = `lidarr.cascadeAnalysis.${section}.${field}`;
          for (const invalid of [
            0,
            -1,
            1.5,
            1_000_001,
            Number.MAX_SAFE_INTEGER + 1,
            "1",
            true,
            null,
          ]) {
            expect(() =>
              validateConfig(
                {
                  lidarr: {
                    cascadeAnalysis: {
                      [section]: { [field]: invalid },
                    },
                  },
                },
                testConfigPath,
              ),
            ).toThrow(ConfigError);

            try {
              validateConfig(
                {
                  lidarr: {
                    cascadeAnalysis: {
                      [section]: { [field]: invalid },
                    },
                  },
                },
                testConfigPath,
              );
              expect.fail("expected cascade analysis validation to fail");
            } catch (error) {
              expect(
                (error as ConfigError).propertyPath,
                `${propertyPath}:${String(invalid)}`,
              ).toBe(propertyPath);
            }
          }
        },
      );
    });

    describe("lidarr.profilePresets validation", () => {
      it("preserves compatible absence and unrelated legacy sibling behavior", () => {
        expect(
          validateConfig({ lidarr: {} }, testConfigPath).lidarr?.profilePresets,
        ).toBeUndefined();
        expect(validateConfig({ lidarr: { legacySetting: true } }, testConfigPath).lidarr).toEqual(
          {},
        );
      });

      it("accepts one complete configured pack without connection settings", () => {
        const config = validateConfiguredPacks({ studio: makeConfiguredPresetPack() });

        expect(config.lidarr?.baseUrl).toBeUndefined();
        expect(config.lidarr?.apiKey).toBeUndefined();
        expect(config.lidarr?.profilePresets?.packs["studio"]).toEqual(makeConfiguredPresetPack());
      });

      it("rejects a configured pack without custom formats at config load", () => {
        const pack = makeConfiguredPresetPack();
        pack.customFormats = [];

        try {
          validateConfiguredPacks({ studio: pack });
          expect.fail("expected configured pack validation to fail");
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).propertyPath).toBe(
            "lidarr.profilePresets.packs.studio.customFormats",
          );
          expect((error as ConfigError).message).toBe(
            "Expected array with 1-100 items for lidarr.profilePresets.packs.studio.customFormats",
          );
        }
      });

      it.each([
        ["inherits", "balanced"],
        ["url", "https://example.com/preset.yaml"],
        ["path", "/tmp/preset.yaml"],
        ["hook", "load-preset"],
      ])("rejects unsupported pack property %s with its exact path", (key, value) => {
        const pack = { ...makeConfiguredPresetPack(), [key]: value };

        try {
          validateConfiguredPacks({ studio: pack });
          expect.fail("expected configured pack validation to fail");
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).propertyPath).toBe(
            `lidarr.profilePresets.packs.studio.${key}`,
          );
        }
      });

      it("rejects an unknown nested property with its exact path", () => {
        const pack = makeConfiguredPresetPack();
        Object.assign(pack.customFormats[0]!.specifications[0]!, { unexpected: true });

        try {
          validateConfiguredPacks({ studio: pack });
          expect.fail("expected configured pack validation to fail");
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).propertyPath).toBe(
            "lidarr.profilePresets.packs.studio.customFormats[0].specifications[0].unexpected",
          );
        }
      });

      it("rejects built-in shadowing and normalized duplicate resource names", () => {
        expect(() => validateConfiguredPacks({ balanced: makeConfiguredPresetPack() })).toThrow(
          "shadows built-in",
        );

        const pack = makeConfiguredPresetPack();
        const duplicate = makeConfiguredPresetPack().customFormats[0]!;
        pack.customFormats.push({
          ...duplicate,
          name: " studio release ",
        });
        expect(() => validateConfiguredPacks({ studio: pack })).toThrow(
          "Duplicate normalized name",
        );
      });

      it("accepts Lidarr's original filename track-token alternative", () => {
        const pack = makeConfiguredPresetPack();
        pack.naming.standardTrackFormat = "{Original Filename}";
        pack.naming.multiDiscTrackFormat = "{Original Filename}";

        expect(
          validateConfiguredPacks({ studio: pack }).lidarr?.profilePresets?.packs["studio"],
        ).toBeDefined();
      });

      it("rejects explicit structural bounds with a precise path", () => {
        const packs = Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [`pack-${index}`, makeConfiguredPresetPack()]),
        );

        try {
          validateConfiguredPacks(packs);
          expect.fail("expected configured pack validation to fail");
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).propertyPath).toBe("lidarr.profilePresets.packs");
        }
      });

      it("rejects a configured pack with an oversized UTF-8 object key", () => {
        const pack = makeConfiguredPresetPack();
        const oversizedKey = "é".repeat((1024 * 1024) / 2);
        Object.assign(pack.customFormats[0]!.specifications[0]!.fields, {
          [oversizedKey]: true,
        });

        expect(() => validateConfiguredPacks({ studio: pack })).toThrow(
          "Expanded preset data exceeds 1048576 bytes",
        );
      });

      it.each([
        {
          mutate: (pack: ReturnType<typeof makeConfiguredPresetPack>) => {
            pack.customFormats[0]!.specifications[0]!.fields.value = "(a+)+";
          },
          path: "lidarr.profilePresets.packs.studio.customFormats[0].specifications[0].fields.value",
        },
        {
          mutate: (pack: ReturnType<typeof makeConfiguredPresetPack>) => {
            pack.naming.artistFolderFormat = "../{Artist Name}";
          },
          path: "lidarr.profilePresets.packs.studio.naming.artistFolderFormat",
        },
      ])("rejects unsafe regex or naming input at $path", ({ mutate, path }) => {
        const pack = makeConfiguredPresetPack();
        mutate(pack);

        try {
          validateConfiguredPacks({ studio: pack });
          expect.fail("expected configured pack validation to fail");
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).propertyPath).toBe(path);
        }
      });

      it("rejects unsafe dynamic fields and dangling format scores before any I/O", () => {
        const unsafeFieldPack = makeConfiguredPresetPack();
        Object.assign(unsafeFieldPack.customFormats[0]!.specifications[0]!.fields, {
          secret: "hidden",
        });
        expect(() => validateConfiguredPacks({ studio: unsafeFieldPack })).toThrow("Unsafe field");

        const danglingScorePack = makeConfiguredPresetPack();
        danglingScorePack.qualityProfiles[0]!.formatScores[0]!.customFormatName = "Missing";
        expect(() => validateConfiguredPacks({ studio: danglingScorePack })).toThrow(
          "Unknown custom format",
        );
      });
    });

    describe("lidarr.resilience validation", () => {
      const POSITIVE_INTEGER_KNOBS = [
        "failureThreshold",
        "failureWindowSeconds",
        "cooldownSeconds",
        "retryBackoffCapMs",
        "cacheStaleMaxAgeSeconds",
        "deferredMaxAttempts",
      ] as const;

      const NON_NEGATIVE_INTEGER_KNOBS = ["retryAttempts", "cacheTtlSeconds"] as const;

      it("should accept a full valid resilience section", () => {
        const config = validateConfig(
          {
            lidarr: {
              resilience: {
                failureThreshold: 3,
                failureWindowSeconds: 300,
                cooldownSeconds: 60,
                retryAttempts: 1,
                retryBackoffCapMs: 15000,
                cacheTtlSeconds: 900,
                cacheStaleMaxAgeSeconds: 86400,
                deferredMaxAttempts: 5,
              },
            },
          },
          testConfigPath,
        );

        expect(config.lidarr?.resilience).toEqual({
          failureThreshold: 3,
          failureWindowSeconds: 300,
          cooldownSeconds: 60,
          retryAttempts: 1,
          retryBackoffCapMs: 15000,
          cacheTtlSeconds: 900,
          cacheStaleMaxAgeSeconds: 86400,
          deferredMaxAttempts: 5,
        });
      });

      it("should leave resilience absent when not configured (no defaults written)", () => {
        const config = validateConfig(
          { lidarr: { baseUrl: "http://localhost:8686" } },
          testConfigPath,
        );

        expect(config.lidarr).toBeDefined();
        expect(config.lidarr?.resilience).toBeUndefined();
      });

      it("should accept an empty resilience object", () => {
        const config = validateConfig({ lidarr: { resilience: {} } }, testConfigPath);

        expect(config.lidarr?.resilience).toEqual({});
      });

      it("should silently drop unknown resilience keys", () => {
        const config = validateConfig(
          {
            lidarr: {
              resilience: {
                failureThreshold: 4,
                enabled: true,
                halfOpenMaxProbes: 2,
              },
            },
          },
          testConfigPath,
        );

        expect(config.lidarr?.resilience).toEqual({ failureThreshold: 4 });
      });

      it("should reject a non-object resilience section", () => {
        expect(() => validateConfig({ lidarr: { resilience: "nope" } }, testConfigPath)).toThrow(
          "Expected object for lidarr.resilience, got string",
        );
      });

      it("should reject an array resilience section with the property path", () => {
        expect(() => validateConfig({ lidarr: { resilience: [] } }, testConfigPath)).toThrow(
          ConfigError,
        );

        try {
          validateConfig({ lidarr: { resilience: [] } }, testConfigPath);
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).message).toContain("Expected object for lidarr.resilience");
          expect((error as ConfigError).propertyPath).toBe("lidarr.resilience");
        }
      });

      it("accepts a positive integer for every positive-only resilience knob", () => {
        for (const knob of POSITIVE_INTEGER_KNOBS) {
          const config = validateConfig({ lidarr: { resilience: { [knob]: 7 } } }, testConfigPath);

          expect(config.lidarr?.resilience?.[knob], knob).toBe(7);
        }
      });

      it("rejects zero for every positive-only resilience knob with its path", () => {
        for (const knob of POSITIVE_INTEGER_KNOBS) {
          expect(() =>
            validateConfig({ lidarr: { resilience: { [knob]: 0 } } }, testConfigPath),
          ).toThrow(ConfigError);

          try {
            validateConfig({ lidarr: { resilience: { [knob]: 0 } } }, testConfigPath);
          } catch (error) {
            expect(error).toBeInstanceOf(ConfigError);
            expect((error as ConfigError).message).toContain(
              `Expected positive integer for lidarr.resilience.${knob}`,
            );
            expect((error as ConfigError).propertyPath).toBe(`lidarr.resilience.${knob}`);
          }
        }
      });

      it("rejects invalid values for every positive-only resilience knob", () => {
        for (const knob of POSITIVE_INTEGER_KNOBS) {
          for (const invalid of [-1, 1.5, "3", true, null]) {
            expect(() =>
              validateConfig({ lidarr: { resilience: { [knob]: invalid } } }, testConfigPath),
            ).toThrow(ConfigError);
          }
        }
      });

      it("accepts zero and positive integers for every non-negative resilience knob", () => {
        for (const knob of NON_NEGATIVE_INTEGER_KNOBS) {
          for (const value of [0, 30]) {
            const config = validateConfig(
              { lidarr: { resilience: { [knob]: value } } },
              testConfigPath,
            );
            expect(config.lidarr?.resilience?.[knob], `${knob}:${value}`).toBe(value);
          }
        }
      });

      it("rejects negative values for every non-negative resilience knob with its path", () => {
        for (const knob of NON_NEGATIVE_INTEGER_KNOBS) {
          expect(() =>
            validateConfig({ lidarr: { resilience: { [knob]: -1 } } }, testConfigPath),
          ).toThrow(ConfigError);

          try {
            validateConfig({ lidarr: { resilience: { [knob]: -1 } } }, testConfigPath);
          } catch (error) {
            expect(error).toBeInstanceOf(ConfigError);
            expect((error as ConfigError).message).toContain(
              `Expected non-negative integer for lidarr.resilience.${knob}`,
            );
            expect((error as ConfigError).propertyPath).toBe(`lidarr.resilience.${knob}`);
          }
        }
      });

      it("rejects non-integers for every non-negative resilience knob", () => {
        for (const knob of NON_NEGATIVE_INTEGER_KNOBS) {
          for (const invalid of [0.5, "1", true, null]) {
            expect(() =>
              validateConfig({ lidarr: { resilience: { [knob]: invalid } } }, testConfigPath),
            ).toThrow(ConfigError);
          }
        }
      });
    });

    describe("lidarr.scheduler validation", () => {
      const LANE_FIELDS = [
        { field: "concurrency", minimum: 1, maximum: 32 },
        { field: "operationBudget", minimum: 1, maximum: 10_000 },
        { field: "retryAttempts", minimum: 0, maximum: 10 },
        { field: "retryBackoffCapMs", minimum: 1, maximum: 300_000 },
      ] as const;

      it("should accept partial overrides for every canonical lane", () => {
        const config = validateConfig(
          {
            lidarr: {
              scheduler: {
                lanes: {
                  "local-only": { concurrency: 8 },
                  "metadata-dependent": { operationBudget: 50 },
                  discovery: { retryAttempts: 2 },
                  destructive: { retryBackoffCapMs: 15_000 },
                },
              },
            },
          },
          testConfigPath,
        );

        expect(config.lidarr?.scheduler).toEqual({
          lanes: {
            "local-only": { concurrency: 8 },
            "metadata-dependent": { operationBudget: 50 },
            discovery: { retryAttempts: 2 },
            destructive: { retryBackoffCapMs: 15_000 },
          },
        });
      });

      it("should leave scheduler absent when not configured", () => {
        const config = validateConfig({ lidarr: {} }, testConfigPath);

        expect(config.lidarr?.scheduler).toBeUndefined();
      });

      it("should accept empty scheduler and lanes objects without writing defaults", () => {
        expect(
          validateConfig({ lidarr: { scheduler: {} } }, testConfigPath).lidarr?.scheduler,
        ).toEqual({});
        expect(
          validateConfig({ lidarr: { scheduler: { lanes: {} } } }, testConfigPath).lidarr
            ?.scheduler,
        ).toEqual({ lanes: {} });
      });

      it("rejects invalid scheduler object layers with their property paths", () => {
        for (const [raw, path] of [
          [{ lidarr: { scheduler: "nope" } }, "lidarr.scheduler"],
          [{ lidarr: { scheduler: { lanes: [] } } }, "lidarr.scheduler.lanes"],
          [
            { lidarr: { scheduler: { lanes: { "local-only": 4 } } } },
            "lidarr.scheduler.lanes.local-only",
          ],
        ] as const) {
          expect(() => validateConfig(raw, testConfigPath)).toThrow(ConfigError);

          try {
            validateConfig(raw, testConfigPath);
          } catch (error) {
            expect((error as ConfigError).propertyPath).toBe(path);
          }
        }
      });

      it("accepts inclusive bounds for every scheduler lane field", () => {
        for (const { field, minimum, maximum } of LANE_FIELDS) {
          for (const value of [minimum, maximum]) {
            const config = validateConfig(
              {
                lidarr: {
                  scheduler: { lanes: { "local-only": { [field]: value } } },
                },
              },
              testConfigPath,
            );

            expect(
              config.lidarr?.scheduler?.lanes?.["local-only"]?.[field],
              `${field}:${value}`,
            ).toBe(value);
          }
        }
      });

      it("rejects invalid values for every scheduler lane field", () => {
        for (const { field, minimum, maximum } of LANE_FIELDS) {
          const propertyPath = `lidarr.scheduler.lanes.local-only.${field}`;
          for (const invalid of [minimum - 1, maximum + 1, 1.5, "1", true, null]) {
            expect(() =>
              validateConfig(
                {
                  lidarr: {
                    scheduler: { lanes: { "local-only": { [field]: invalid } } },
                  },
                },
                testConfigPath,
              ),
            ).toThrow(ConfigError);

            try {
              validateConfig(
                {
                  lidarr: {
                    scheduler: { lanes: { "local-only": { [field]: invalid } } },
                  },
                },
                testConfigPath,
              );
            } catch (error) {
              expect((error as ConfigError).propertyPath).toBe(propertyPath);
            }
          }
        }
      });

      it("should silently drop unknown scheduler, lane, and field keys", () => {
        const config = validateConfig(
          {
            lidarr: {
              scheduler: {
                enabled: true,
                lanes: {
                  "local-only": { concurrency: 4, burst: 99 },
                  experimental: { concurrency: 31 },
                },
              },
            },
          },
          testConfigPath,
        );

        expect(config.lidarr?.scheduler).toEqual({
          lanes: { "local-only": { concurrency: 4 } },
        });
      });
    });
  });

  describe("discovery.lastfm validation", () => {
    it("accepts the exact optional shape without introducing defaults", () => {
      expect(validateConfig({}, testConfigPath).discovery).toBeUndefined();
      expect(validateConfig({ discovery: {} }, testConfigPath).discovery).toEqual({});
      expect(
        validateConfig(
          { discovery: { lastfm: { apiKey: "lastfm-secret", timeoutMs: 15_000 } } },
          testConfigPath,
        ).discovery,
      ).toEqual({
        lastfm: { apiKey: "lastfm-secret", timeoutMs: 15_000 },
      });
    });

    it.each([
      [{ discovery: "lastfm" }, "discovery"],
      [{ discovery: { lastfm: [] } }, "discovery.lastfm"],
      [{ discovery: { provider: "lastfm" } }, "discovery.provider"],
      [{ discovery: { lastfm: { endpoint: "https://example.com" } } }, "discovery.lastfm.endpoint"],
    ])("rejects invalid or unknown nested shape at %s", (raw, propertyPath) => {
      try {
        validateConfig(raw, testConfigPath);
        expect.fail("expected discovery configuration validation to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).propertyPath).toBe(propertyPath);
      }
    });

    it("rejects unsafe credentials and enforces timeout bounds", () => {
      for (const apiKey of ["", "   ", "line\nbreak", "\u202esecret", "x".repeat(1_025), 123]) {
        expect(() => validateConfig({ discovery: { lastfm: { apiKey } } }, testConfigPath)).toThrow(
          ConfigError,
        );
      }

      for (const timeoutMs of [0, 300_001, 1.5, "15000", null]) {
        expect(() =>
          validateConfig({ discovery: { lastfm: { timeoutMs } } }, testConfigPath),
        ).toThrow("Expected integer between 1 and 300000 for discovery.lastfm.timeoutMs");
      }
    });

    it("recursively redacts Last.fm API keys from config merge diagnostics", () => {
      mergeConfigs(
        { discovery: { lastfm: { apiKey: "resolved-lastfm-secret" } } },
        { discovery: { lastfm: { apiKey: "template-lastfm-secret" } } },
      );

      const diagnostics = mockLogger.logDebug.mock.calls.flat().join("\n");
      expect(diagnostics).toContain("discovery.lastfm.apiKey");
      expect(diagnostics).toContain("[REDACTED]");
      expect(diagnostics).not.toContain("resolved-lastfm-secret");
      expect(diagnostics).not.toContain("template-lastfm-secret");
    });
  });

  describe("policy validation", () => {
    it("accepts the exact optional shape without introducing defaults", () => {
      expect(validateConfig({}, testConfigPath).policy).toBeUndefined();
      expect(validateConfig({ policy: {} }, testConfigPath).policy).toEqual({});
      expect(validateConfig({ policy: { rules: {} } }, testConfigPath).policy).toEqual({
        rules: {},
      });

      expect(
        validateConfig(
          {
            policy: {
              plexLibrary: "Music",
              rules: {
                "rating-quality-upgrade": {
                  enabled: true,
                  minRating: 4,
                  targetQualityProfile: "Lossless",
                  maxProposals: 25,
                },
                "stale-monitoring-cleanup": {
                  enabled: false,
                  maxPlays: 0,
                  minDaysSinceLastViewed: 90,
                  protectRatingAtOrAbove: 4,
                  requireTrackCoverage: true,
                  minTrackFileCount: 1,
                  maxProposals: 25,
                },
                "discovery-seed": { enabled: false, minRating: 5, minPlays: 25, maxSeeds: 10 },
              },
            },
          },
          testConfigPath,
        ).policy,
      ).toEqual({
        plexLibrary: "Music",
        rules: {
          "rating-quality-upgrade": {
            enabled: true,
            minRating: 4,
            targetQualityProfile: "Lossless",
            maxProposals: 25,
          },
          "stale-monitoring-cleanup": {
            enabled: false,
            maxPlays: 0,
            minDaysSinceLastViewed: 90,
            protectRatingAtOrAbove: 4,
            requireTrackCoverage: true,
            minTrackFileCount: 1,
            maxProposals: 25,
          },
          "discovery-seed": { enabled: false, minRating: 5, minPlays: 25, maxSeeds: 10 },
        },
      });
    });

    it("accepts targetQualityProfile as a numeric id and normalises it to a string", () => {
      const policy = validateConfig(
        { policy: { rules: { "rating-quality-upgrade": { targetQualityProfile: 6 } } } },
        testConfigPath,
      ).policy;

      expect(policy?.rules?.["rating-quality-upgrade"]).toEqual({ targetQualityProfile: "6" });
    });

    it("preserves falsy operator values instead of dropping them", () => {
      const policy = validateConfig(
        {
          policy: {
            rules: {
              "stale-monitoring-cleanup": { enabled: false, maxPlays: 0, minTrackFileCount: 0 },
              "discovery-seed": { enabled: false, minPlays: 0 },
            },
          },
        },
        testConfigPath,
      ).policy;

      expect(policy?.rules?.["stale-monitoring-cleanup"]).toEqual({
        enabled: false,
        maxPlays: 0,
        minTrackFileCount: 0,
      });
      expect(policy?.rules?.["discovery-seed"]).toEqual({ enabled: false, minPlays: 0 });
    });

    it.each<[unknown, string]>([
      // Top level
      [{ policy: "Music" }, "policy"],
      [{ policy: [] }, "policy"],
      [{ policy: { library: "Music" } }, "policy.library"],
      [{ policy: { plexLibrary: 42 } }, "policy.plexLibrary"],
      [{ policy: { plexLibrary: "   " } }, "policy.plexLibrary"],
      // policy.rules container
      [{ policy: { rules: [] } }, "policy.rules"],
      [{ policy: { rules: "all" } }, "policy.rules"],
      // Unknown rule id
      [{ policy: { rules: { "typo-rule": {} } } }, "policy.rules.typo-rule"],
      [
        { policy: { rules: { "stale-monitoring": { enabled: true } } } },
        "policy.rules.stale-monitoring",
      ],
      // rating-quality-upgrade
      [
        { policy: { rules: { "rating-quality-upgrade": [] } } },
        "policy.rules.rating-quality-upgrade",
      ],
      [
        { policy: { rules: { "rating-quality-upgrade": { minStars: 4 } } } },
        "policy.rules.rating-quality-upgrade.minStars",
      ],
      [
        { policy: { rules: { "rating-quality-upgrade": { enabled: "yes" } } } },
        "policy.rules.rating-quality-upgrade.enabled",
      ],
      [
        { policy: { rules: { "rating-quality-upgrade": { minRating: "4" } } } },
        "policy.rules.rating-quality-upgrade.minRating",
      ],
      [
        { policy: { rules: { "rating-quality-upgrade": { targetQualityProfile: "  " } } } },
        "policy.rules.rating-quality-upgrade.targetQualityProfile",
      ],
      [
        { policy: { rules: { "rating-quality-upgrade": { targetQualityProfile: 0 } } } },
        "policy.rules.rating-quality-upgrade.targetQualityProfile",
      ],
      [
        { policy: { rules: { "rating-quality-upgrade": { targetQualityProfile: 6.5 } } } },
        "policy.rules.rating-quality-upgrade.targetQualityProfile",
      ],
      [
        { policy: { rules: { "rating-quality-upgrade": { maxProposals: 0 } } } },
        "policy.rules.rating-quality-upgrade.maxProposals",
      ],
      // stale-monitoring-cleanup
      [
        { policy: { rules: { "stale-monitoring-cleanup": 3 } } },
        "policy.rules.stale-monitoring-cleanup",
      ],
      [
        { policy: { rules: { "stale-monitoring-cleanup": { maxPlayCount: 0 } } } },
        "policy.rules.stale-monitoring-cleanup.maxPlayCount",
      ],
      [
        { policy: { rules: { "stale-monitoring-cleanup": { enabled: 1 } } } },
        "policy.rules.stale-monitoring-cleanup.enabled",
      ],
      [
        { policy: { rules: { "stale-monitoring-cleanup": { maxPlays: -1 } } } },
        "policy.rules.stale-monitoring-cleanup.maxPlays",
      ],
      [
        { policy: { rules: { "stale-monitoring-cleanup": { protectRatingAtOrAbove: 0.5 } } } },
        "policy.rules.stale-monitoring-cleanup.protectRatingAtOrAbove",
      ],
      [
        { policy: { rules: { "stale-monitoring-cleanup": { requireTrackCoverage: "true" } } } },
        "policy.rules.stale-monitoring-cleanup.requireTrackCoverage",
      ],
      [
        { policy: { rules: { "stale-monitoring-cleanup": { minTrackFileCount: 1.5 } } } },
        "policy.rules.stale-monitoring-cleanup.minTrackFileCount",
      ],
      [
        { policy: { rules: { "stale-monitoring-cleanup": { maxProposals: 101 } } } },
        "policy.rules.stale-monitoring-cleanup.maxProposals",
      ],
      // discovery-seed
      [{ policy: { rules: { "discovery-seed": null } } }, "policy.rules.discovery-seed"],
      [
        { policy: { rules: { "discovery-seed": { maxSeed: 10 } } } },
        "policy.rules.discovery-seed.maxSeed",
      ],
      [
        { policy: { rules: { "discovery-seed": { enabled: "false" } } } },
        "policy.rules.discovery-seed.enabled",
      ],
      [
        { policy: { rules: { "discovery-seed": { minRating: 6 } } } },
        "policy.rules.discovery-seed.minRating",
      ],
      [
        { policy: { rules: { "discovery-seed": { minPlays: -5 } } } },
        "policy.rules.discovery-seed.minPlays",
      ],
      [
        { policy: { rules: { "discovery-seed": { maxSeeds: 0 } } } },
        "policy.rules.discovery-seed.maxSeeds",
      ],
    ])("rejects invalid or unknown nested shape at %s", (raw, propertyPath) => {
      try {
        validateConfig(raw, testConfigPath);
        expect.fail("expected policy configuration validation to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).propertyPath).toBe(propertyPath);
      }
    });

    it.each([1, 36_500])("accepts minDaysSinceLastViewed boundary %i", (value) => {
      expect(
        validateConfig(
          {
            policy: {
              rules: { "stale-monitoring-cleanup": { minDaysSinceLastViewed: value } },
            },
          },
          testConfigPath,
        ).policy?.rules?.["stale-monitoring-cleanup"],
      ).toEqual({ minDaysSinceLastViewed: value });
    });

    it.each([
      ["wrong type", "90"],
      ["fractional", 90.5],
      ["underflow", 0],
      ["overflow", 36_501],
    ] as const)("rejects %s minDaysSinceLastViewed with the exact path", (_label, value) => {
      try {
        validateConfig(
          {
            policy: {
              rules: { "stale-monitoring-cleanup": { minDaysSinceLastViewed: value } },
            },
          },
          testConfigPath,
        );
        expect.fail("expected recency threshold validation to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).propertyPath).toBe(
          "policy.rules.stale-monitoring-cleanup.minDaysSinceLastViewed",
        );
      }
    });

    it("enforces the 1.0-5.0 star bounds on every rating threshold", () => {
      const ratingPaths: Array<[string, string]> = [
        ["rating-quality-upgrade", "minRating"],
        ["stale-monitoring-cleanup", "protectRatingAtOrAbove"],
        ["discovery-seed", "minRating"],
      ];

      for (const [ruleId, field] of ratingPaths) {
        // `Number.NaN` and `Number.POSITIVE_INFINITY` are what YAML's `.nan` and
        // `.inf` literals load as; a NaN threshold would pass a bare bounds
        // check and silently disable the rating veto it configures.
        for (const value of [
          0,
          0.99,
          5.01,
          6,
          "4",
          null,
          true,
          Number.NaN,
          Number.POSITIVE_INFINITY,
        ]) {
          expect(() =>
            validateConfig({ policy: { rules: { [ruleId]: { [field]: value } } } }, testConfigPath),
          ).toThrow(`Expected number between 1.0 and 5.0 for policy.rules.${ruleId}.${field}`);
        }

        for (const value of [1, 2.5, 5]) {
          expect(() =>
            validateConfig({ policy: { rules: { [ruleId]: { [field]: value } } } }, testConfigPath),
          ).not.toThrow();
        }
      }
    });

    it("enforces every bounded-integer ceiling", () => {
      const boundedFields: Array<[string, string, number, number]> = [
        ["stale-monitoring-cleanup", "maxPlays", 0, 1_000_000],
        ["stale-monitoring-cleanup", "minTrackFileCount", 0, 1_000_000],
        ["stale-monitoring-cleanup", "maxProposals", 1, 100],
        ["rating-quality-upgrade", "maxProposals", 1, 100],
        ["discovery-seed", "minPlays", 0, 1_000_000],
        ["discovery-seed", "maxSeeds", 1, 100],
      ];

      for (const [ruleId, field, minimum, maximum] of boundedFields) {
        const message = `Expected integer between ${minimum} and ${maximum} for policy.rules.${ruleId}.${field}`;

        for (const value of [minimum - 1, maximum + 1, minimum + 0.5, `${minimum}`, null]) {
          expect(() =>
            validateConfig({ policy: { rules: { [ruleId]: { [field]: value } } } }, testConfigPath),
          ).toThrow(message);
        }

        for (const value of [minimum, maximum]) {
          expect(() =>
            validateConfig({ policy: { rules: { [ruleId]: { [field]: value } } } }, testConfigPath),
          ).not.toThrow();
        }
      }
    });

    it("accepts exactly the declared policy rule ids and rejects every other key", () => {
      expect(POLICY_RULE_IDS).toHaveLength(3);

      for (const ruleId of POLICY_RULE_IDS) {
        expect(
          validateConfig({ policy: { rules: { [ruleId]: {} } } }, testConfigPath).policy,
        ).toEqual({ rules: { [ruleId]: {} } });
      }

      for (const unknownRuleId of [
        "rating-quality-upgrades",
        "Discovery-Seed",
        "stale_monitoring_cleanup",
        "plexLibrary",
      ]) {
        try {
          validateConfig({ policy: { rules: { [unknownRuleId]: {} } } }, testConfigPath);
          expect.fail(`expected unknown rule id ${unknownRuleId} to be rejected`);
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).propertyPath).toBe(`policy.rules.${unknownRuleId}`);
        }
      }
    });

    describe("policy overrides", () => {
      const fingerprint = `sha256:${"a".repeat(64)}`;
      const key = "stale-monitoring-cleanup:artist:233";

      function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
        return {
          action: "suppress",
          evidenceFingerprint: fingerprint,
          reason: "Reviewed with the library owner",
          ...overrides,
        };
      }

      it("retains an exact suppression record without introducing defaults", () => {
        const policy = validateConfig(
          { policy: { overrides: { [key]: entry() } } },
          testConfigPath,
        ).policy;

        expect(policy?.overrides).toEqual({
          [key]: {
            action: "suppress",
            evidenceFingerprint: fingerprint,
            reason: "Reviewed with the library owner",
          },
        });
      });

      it("accepts a null-prototype mapping and entry", () => {
        const overrideEntry = Object.assign(
          Object.create(null) as Record<string, unknown>,
          entry(),
        );
        const overrides = Object.create(null) as Record<string, unknown>;
        overrides[key] = overrideEntry;

        expect(validateConfig({ policy: { overrides } }, testConfigPath).policy?.overrides).toEqual(
          {
            [key]: entry(),
          },
        );
      });

      it.each([
        { name: "array mapping", overrides: [], propertyPath: "policy.overrides" },
        {
          name: "inherited mapping entry",
          overrides: Object.create({ [key]: entry() }),
          propertyPath: "policy.overrides",
        },
        {
          name: "inherited entry fields",
          overrides: { [key]: Object.create(entry()) },
          propertyPath: `policy.overrides["${key}"]`,
        },
        {
          name: "skip key",
          overrides: { [`${key}:rating-protected`]: entry() },
          propertyPath: `policy.overrides["${key}:rating-protected"]`,
        },
        {
          name: "unknown rule",
          overrides: { "unknown:artist:233": entry() },
          propertyPath: 'policy.overrides["unknown:artist:233"]',
        },
        {
          name: "wrong rule subject kind",
          overrides: { "discovery-seed:artist:233": entry() },
          propertyPath: 'policy.overrides["discovery-seed:artist:233"]',
        },
        {
          name: "noncanonical artist id",
          overrides: { "stale-monitoring-cleanup:artist:0233": entry() },
          propertyPath: 'policy.overrides["stale-monitoring-cleanup:artist:0233"]',
        },
        {
          name: "unknown entry field",
          overrides: { [key]: entry({ note: "nope" }) },
          propertyPath: `policy.overrides["${key}"].note`,
        },
        {
          name: "missing action",
          overrides: {
            [key]: { evidenceFingerprint: fingerprint, reason: "Reviewed" },
          },
          propertyPath: `policy.overrides["${key}"].action`,
        },
        {
          name: "missing fingerprint",
          overrides: { [key]: { action: "suppress", reason: "Reviewed" } },
          propertyPath: `policy.overrides["${key}"].evidenceFingerprint`,
        },
        {
          name: "missing reason",
          overrides: { [key]: { action: "suppress", evidenceFingerprint: fingerprint } },
          propertyPath: `policy.overrides["${key}"].reason`,
        },
        {
          name: "unsupported action",
          overrides: { [key]: entry({ action: "force" }) },
          propertyPath: `policy.overrides["${key}"].action`,
        },
        {
          name: "hostile action value",
          overrides: { [key]: entry({ action: Object.create(null) }) },
          propertyPath: `policy.overrides["${key}"].action`,
        },
        {
          name: "uppercase fingerprint",
          overrides: { [key]: entry({ evidenceFingerprint: `sha256:${"A".repeat(64)}` }) },
          propertyPath: `policy.overrides["${key}"].evidenceFingerprint`,
        },
        {
          name: "untrimmed reason",
          overrides: { [key]: entry({ reason: " reviewed " }) },
          propertyPath: `policy.overrides["${key}"].reason`,
        },
        {
          name: "control in reason",
          overrides: { [key]: entry({ reason: "reviewed\nforged" }) },
          propertyPath: `policy.overrides["${key}"].reason`,
        },
        {
          name: "bidi in reason",
          overrides: { [key]: entry({ reason: "reviewed\u202eforged" }) },
          propertyPath: `policy.overrides["${key}"].reason`,
        },
        {
          name: "reason over 512 UTF-8 bytes",
          overrides: { [key]: entry({ reason: `${"é".repeat(256)}a` }) },
          propertyPath: `policy.overrides["${key}"].reason`,
        },
      ])("rejects $name with the exact bracketed path", ({ overrides, propertyPath }) => {
        try {
          validateConfig({ policy: { overrides } }, testConfigPath);
          expect.unreachable("expected invalid override config to throw");
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).propertyPath).toBe(propertyPath);
        }
      });

      it("accepts a reason at the exact 512 UTF-8 byte boundary", () => {
        const reason = "é".repeat(256);

        expect(
          validateConfig({ policy: { overrides: { [key]: entry({ reason }) } } }, testConfigPath)
            .policy?.overrides?.[key]?.reason,
        ).toBe(reason);
      });

      it.each([
        ["C1", `unknown\u0085field`, "\\u0085"],
        ["ESC", `unknown\u001bfield`, "\\u001b"],
        ["bidi", `unknown\u202efield`, "\\u202e"],
      ])("escapes %s controls in dynamic override diagnostics", (_name, hostile, escaped) => {
        const invalidKey = `stale-monitoring-cleanup:artist:233${hostile}`;

        for (const overrides of [
          { [invalidKey]: entry() },
          { [key]: entry({ [hostile]: true }) },
        ]) {
          try {
            validateConfig({ policy: { overrides } }, testConfigPath);
            expect.unreachable("expected hostile override config to throw");
          } catch (error) {
            expect(error).toBeInstanceOf(ConfigError);
            expect((error as ConfigError).propertyPath).toContain(escaped);
            expect((error as ConfigError).propertyPath).not.toContain(hostile);
            expect((error as Error).message).not.toContain(hostile);
          }
        }
      });

      it("accepts exactly 500 records and rejects the 501st before validating entries", () => {
        const overrides = Object.fromEntries(
          Array.from({ length: 500 }, (_, index) => [
            `stale-monitoring-cleanup:artist:${index + 1}`,
            entry(),
          ]),
        );

        expect(
          Object.keys(
            validateConfig({ policy: { overrides } }, testConfigPath).policy?.overrides ?? {},
          ),
        ).toHaveLength(500);
        overrides["stale-monitoring-cleanup:artist:501"] = entry();

        try {
          validateConfig({ policy: { overrides } }, testConfigPath);
          expect.unreachable("expected oversized override mapping to throw");
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).propertyPath).toBe("policy.overrides");
        }
      });

      it("rejects prototype-like mapping keys without prototype pollution", () => {
        const overrides = Object.create(null) as Record<string, unknown>;
        overrides["__proto__"] = entry();

        expect(() => validateConfig({ policy: { overrides } }, testConfigPath)).toThrow(
          ConfigError,
        );
        expect(Object.prototype).not.toHaveProperty("polluted");
      });

      it("rejects non-enumerable mapping properties", () => {
        const overrides = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(overrides, key, { value: entry(), enumerable: false });

        try {
          validateConfig({ policy: { overrides } }, testConfigPath);
          expect.unreachable("expected hidden override property to throw");
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).propertyPath).toBe(`policy.overrides["${key}"]`);
        }
      });

      it("rejects a throwing mapping getter without invoking it", () => {
        const getter = vi.fn(() => {
          throw new Error("mapping getter must not run");
        });
        const overrides = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(overrides, key, { enumerable: true, get: getter });

        try {
          validateConfig({ policy: { overrides } }, testConfigPath);
          expect.unreachable("expected mapping accessor to throw");
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).propertyPath).toBe(`policy.overrides["${key}"]`);
        }
        expect(getter).not.toHaveBeenCalled();
      });

      it("rejects a stateful entry getter without invoking it", () => {
        const getter = vi.fn(() => "suppress");
        const overrideEntry = entry();
        Object.defineProperty(overrideEntry, "action", { enumerable: true, get: getter });

        try {
          validateConfig({ policy: { overrides: { [key]: overrideEntry } } }, testConfigPath);
          expect.unreachable("expected entry accessor to throw");
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).propertyPath).toBe(`policy.overrides["${key}"].action`);
        }
        expect(getter).not.toHaveBeenCalled();
      });
    });
  });

  describe("plex.defaultFilters validation", () => {
    describe("minPlays", () => {
      it("should accept minPlays: 0 as valid", () => {
        const config = validateConfig(
          {
            plex: {
              defaultFilters: {
                minPlays: 0,
              },
            },
          },
          testConfigPath,
        );

        expect(config.plex?.defaultFilters?.minPlays).toBe(0);
      });

      it("should accept minPlays: 5 as valid", () => {
        const config = validateConfig(
          {
            plex: {
              defaultFilters: {
                minPlays: 5,
              },
            },
          },
          testConfigPath,
        );

        expect(config.plex?.defaultFilters?.minPlays).toBe(5);
      });

      it("should accept minPlays: 100 as valid", () => {
        const config = validateConfig(
          {
            plex: {
              defaultFilters: {
                minPlays: 100,
              },
            },
          },
          testConfigPath,
        );

        expect(config.plex?.defaultFilters?.minPlays).toBe(100);
      });

      it("should reject minPlays: -1 as invalid", () => {
        expect(() =>
          validateConfig(
            {
              plex: {
                defaultFilters: {
                  minPlays: -1,
                },
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);

        try {
          validateConfig(
            {
              plex: {
                defaultFilters: {
                  minPlays: -1,
                },
              },
            },
            testConfigPath,
          );
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).message).toContain("non-negative integer");
          expect((error as ConfigError).propertyPath).toBe("plex.defaultFilters.minPlays");
        }
      });

      it("should reject minPlays: 1.5 as invalid (not an integer)", () => {
        expect(() =>
          validateConfig(
            {
              plex: {
                defaultFilters: {
                  minPlays: 1.5,
                },
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);

        try {
          validateConfig(
            {
              plex: {
                defaultFilters: {
                  minPlays: 1.5,
                },
              },
            },
            testConfigPath,
          );
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).message).toContain("non-negative integer");
        }
      });

      it('should reject minPlays: "5" as invalid (wrong type)', () => {
        expect(() =>
          validateConfig(
            {
              plex: {
                defaultFilters: {
                  minPlays: "5",
                },
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);
      });
    });

    describe("excludeGenres", () => {
      it('should accept excludeGenres: ["Rock", "Pop"] as valid', () => {
        const config = validateConfig(
          {
            plex: {
              defaultFilters: {
                excludeGenres: ["Rock", "Pop"],
              },
            },
          },
          testConfigPath,
        );

        expect(config.plex?.defaultFilters?.excludeGenres).toEqual(["Rock", "Pop"]);
      });

      it("should accept excludeGenres: [] as valid (empty array)", () => {
        const config = validateConfig(
          {
            plex: {
              defaultFilters: {
                excludeGenres: [],
              },
            },
          },
          testConfigPath,
        );

        expect(config.plex?.defaultFilters?.excludeGenres).toEqual([]);
      });

      it('should accept excludeGenres: ["Jazz"] as valid (single item)', () => {
        const config = validateConfig(
          {
            plex: {
              defaultFilters: {
                excludeGenres: ["Jazz"],
              },
            },
          },
          testConfigPath,
        );

        expect(config.plex?.defaultFilters?.excludeGenres).toEqual(["Jazz"]);
      });

      it('should reject excludeGenres: "not-array" as invalid (wrong type)', () => {
        expect(() =>
          validateConfig(
            {
              plex: {
                defaultFilters: {
                  excludeGenres: "not-array",
                },
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);

        try {
          validateConfig(
            {
              plex: {
                defaultFilters: {
                  excludeGenres: "not-array",
                },
              },
            },
            testConfigPath,
          );
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).message).toContain("array of strings");
          expect((error as ConfigError).propertyPath).toBe("plex.defaultFilters.excludeGenres");
        }
      });

      it("should reject excludeGenres: [1, 2, 3] as invalid (wrong item type)", () => {
        expect(() =>
          validateConfig(
            {
              plex: {
                defaultFilters: {
                  excludeGenres: [1, 2, 3],
                },
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);
      });

      it('should reject excludeGenres: ["Rock", 123] as invalid (mixed types)', () => {
        expect(() =>
          validateConfig(
            {
              plex: {
                defaultFilters: {
                  excludeGenres: ["Rock", 123],
                },
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);
      });
    });

    describe("empty defaultFilters object", () => {
      it("should accept empty defaultFilters object as valid", () => {
        const config = validateConfig(
          {
            plex: {
              defaultFilters: {},
            },
          },
          testConfigPath,
        );

        expect(config.plex?.defaultFilters).toEqual({});
      });
    });

    describe("defaultFilters type validation", () => {
      it("should reject defaultFilters: [] as invalid (array instead of object)", () => {
        expect(() =>
          validateConfig(
            {
              plex: {
                defaultFilters: [],
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);

        try {
          validateConfig(
            {
              plex: {
                defaultFilters: [],
              },
            },
            testConfigPath,
          );
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).message).toContain("Expected object");
        }
      });

      it("should reject defaultFilters: null as invalid", () => {
        expect(() =>
          validateConfig(
            {
              plex: {
                defaultFilters: null,
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);
      });
    });
  });

  describe("plex.playlistDefaults validation", () => {
    describe("smart", () => {
      it("should accept smart: true as valid", () => {
        const config = validateConfig(
          {
            plex: {
              playlistDefaults: {
                smart: true,
              },
            },
          },
          testConfigPath,
        );

        expect(config.plex?.playlistDefaults?.smart).toBe(true);
      });

      it("should accept smart: false as valid", () => {
        const config = validateConfig(
          {
            plex: {
              playlistDefaults: {
                smart: false,
              },
            },
          },
          testConfigPath,
        );

        expect(config.plex?.playlistDefaults?.smart).toBe(false);
      });

      it('should reject smart: "yes" as invalid (wrong type)', () => {
        expect(() =>
          validateConfig(
            {
              plex: {
                playlistDefaults: {
                  smart: "yes",
                },
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);

        try {
          validateConfig(
            {
              plex: {
                playlistDefaults: {
                  smart: "yes",
                },
              },
            },
            testConfigPath,
          );
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).message).toContain("Expected boolean");
          expect((error as ConfigError).propertyPath).toBe("plex.playlistDefaults.smart");
        }
      });

      it("should reject smart: 1 as invalid (number instead of boolean)", () => {
        expect(() =>
          validateConfig(
            {
              plex: {
                playlistDefaults: {
                  smart: 1,
                },
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);
      });

      it('should reject smart: "true" as invalid (string instead of boolean)', () => {
        expect(() =>
          validateConfig(
            {
              plex: {
                playlistDefaults: {
                  smart: "true",
                },
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);
      });
    });

    describe("updateExisting", () => {
      it("should accept updateExisting: true as valid", () => {
        const config = validateConfig(
          {
            plex: {
              playlistDefaults: {
                updateExisting: true,
              },
            },
          },
          testConfigPath,
        );

        expect(config.plex?.playlistDefaults?.updateExisting).toBe(true);
      });

      it("should accept updateExisting: false as valid", () => {
        const config = validateConfig(
          {
            plex: {
              playlistDefaults: {
                updateExisting: false,
              },
            },
          },
          testConfigPath,
        );

        expect(config.plex?.playlistDefaults?.updateExisting).toBe(false);
      });

      it("should reject updateExisting: 1 as invalid (number instead of boolean)", () => {
        expect(() =>
          validateConfig(
            {
              plex: {
                playlistDefaults: {
                  updateExisting: 1,
                },
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);

        try {
          validateConfig(
            {
              plex: {
                playlistDefaults: {
                  updateExisting: 1,
                },
              },
            },
            testConfigPath,
          );
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).message).toContain("Expected boolean");
          expect((error as ConfigError).propertyPath).toBe("plex.playlistDefaults.updateExisting");
        }
      });

      it("should reject updateExisting: 0 as invalid (zero is not false)", () => {
        expect(() =>
          validateConfig(
            {
              plex: {
                playlistDefaults: {
                  updateExisting: 0,
                },
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);
      });

      it('should reject updateExisting: "no" as invalid (wrong type)', () => {
        expect(() =>
          validateConfig(
            {
              plex: {
                playlistDefaults: {
                  updateExisting: "no",
                },
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);
      });
    });

    describe("empty playlistDefaults object", () => {
      it("should accept empty playlistDefaults object as valid", () => {
        const config = validateConfig(
          {
            plex: {
              playlistDefaults: {},
            },
          },
          testConfigPath,
        );

        expect(config.plex?.playlistDefaults).toEqual({});
      });
    });

    describe("combined playlistDefaults properties", () => {
      it("should accept both smart and updateExisting as valid", () => {
        const config = validateConfig(
          {
            plex: {
              playlistDefaults: {
                smart: true,
                updateExisting: false,
              },
            },
          },
          testConfigPath,
        );

        expect(config.plex?.playlistDefaults?.smart).toBe(true);
        expect(config.plex?.playlistDefaults?.updateExisting).toBe(false);
      });
    });

    describe("playlistDefaults type validation", () => {
      it('should reject playlistDefaults: "string" as invalid', () => {
        expect(() =>
          validateConfig(
            {
              plex: {
                playlistDefaults: "string",
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);
      });

      it("should reject playlistDefaults: [] as invalid (array instead of object)", () => {
        expect(() =>
          validateConfig(
            {
              plex: {
                playlistDefaults: [],
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);
      });
    });
  });

  describe("plex.cache validation", () => {
    describe("enabled", () => {
      it("should accept enabled: true as valid", () => {
        const config = validateConfig(
          {
            plex: {
              cache: {
                enabled: true,
              },
            },
          },
          testConfigPath,
        );

        expect(config.plex?.cache?.enabled).toBe(true);
      });

      it("should accept enabled: false as valid", () => {
        const config = validateConfig(
          {
            plex: {
              cache: {
                enabled: false,
              },
            },
          },
          testConfigPath,
        );

        expect(config.plex?.cache?.enabled).toBe(false);
      });

      it('should reject enabled: "true" as invalid (wrong type)', () => {
        expect(() =>
          validateConfig(
            {
              plex: {
                cache: {
                  enabled: "true",
                },
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);

        try {
          validateConfig(
            {
              plex: {
                cache: {
                  enabled: "true",
                },
              },
            },
            testConfigPath,
          );
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).message).toContain("Expected boolean");
          expect((error as ConfigError).propertyPath).toBe("plex.cache.enabled");
        }
      });

      it("should reject enabled: 1 as invalid (number instead of boolean)", () => {
        expect(() =>
          validateConfig(
            {
              plex: {
                cache: {
                  enabled: 1,
                },
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);
      });
    });

    describe("ttlSeconds", () => {
      it("should accept ttlSeconds: 300 as valid", () => {
        const config = validateConfig(
          {
            plex: {
              cache: {
                ttlSeconds: 300,
              },
            },
          },
          testConfigPath,
        );

        expect(config.plex?.cache?.ttlSeconds).toBe(300);
      });

      it("should accept ttlSeconds: 1 as valid (minimum positive)", () => {
        const config = validateConfig(
          {
            plex: {
              cache: {
                ttlSeconds: 1,
              },
            },
          },
          testConfigPath,
        );

        expect(config.plex?.cache?.ttlSeconds).toBe(1);
      });

      it("should accept ttlSeconds: 86400 as valid (24 hours)", () => {
        const config = validateConfig(
          {
            plex: {
              cache: {
                ttlSeconds: 86400,
              },
            },
          },
          testConfigPath,
        );

        expect(config.plex?.cache?.ttlSeconds).toBe(86400);
      });

      it("should reject ttlSeconds: 0 as invalid", () => {
        expect(() =>
          validateConfig(
            {
              plex: {
                cache: {
                  ttlSeconds: 0,
                },
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);

        try {
          validateConfig(
            {
              plex: {
                cache: {
                  ttlSeconds: 0,
                },
              },
            },
            testConfigPath,
          );
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).message).toContain("positive integer");
          expect((error as ConfigError).propertyPath).toBe("plex.cache.ttlSeconds");
        }
      });

      it("should reject ttlSeconds: -1 as invalid", () => {
        expect(() =>
          validateConfig(
            {
              plex: {
                cache: {
                  ttlSeconds: -1,
                },
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);

        try {
          validateConfig(
            {
              plex: {
                cache: {
                  ttlSeconds: -1,
                },
              },
            },
            testConfigPath,
          );
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).message).toContain("positive integer");
        }
      });

      it("should reject ttlSeconds: -100 as invalid", () => {
        expect(() =>
          validateConfig(
            {
              plex: {
                cache: {
                  ttlSeconds: -100,
                },
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);
      });

      it("should reject ttlSeconds: 30.5 as invalid (not an integer)", () => {
        expect(() =>
          validateConfig(
            {
              plex: {
                cache: {
                  ttlSeconds: 30.5,
                },
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);
      });

      it('should reject ttlSeconds: "300" as invalid (wrong type)', () => {
        expect(() =>
          validateConfig(
            {
              plex: {
                cache: {
                  ttlSeconds: "300",
                },
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);
      });
    });

    describe("empty cache object", () => {
      it("should accept empty cache object as valid", () => {
        const config = validateConfig(
          {
            plex: {
              cache: {},
            },
          },
          testConfigPath,
        );

        expect(config.plex?.cache).toEqual({});
      });
    });

    describe("combined cache properties", () => {
      it("should accept both enabled and ttlSeconds as valid", () => {
        const config = validateConfig(
          {
            plex: {
              cache: {
                enabled: true,
                ttlSeconds: 300,
              },
            },
          },
          testConfigPath,
        );

        expect(config.plex?.cache?.enabled).toBe(true);
        expect(config.plex?.cache?.ttlSeconds).toBe(300);
      });

      it("should accept disabled cache with ttlSeconds as valid", () => {
        const config = validateConfig(
          {
            plex: {
              cache: {
                enabled: false,
                ttlSeconds: 600,
              },
            },
          },
          testConfigPath,
        );

        expect(config.plex?.cache?.enabled).toBe(false);
        expect(config.plex?.cache?.ttlSeconds).toBe(600);
      });
    });

    describe("cache type validation", () => {
      it('should reject cache: "string" as invalid', () => {
        expect(() =>
          validateConfig(
            {
              plex: {
                cache: "string",
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);
      });

      it("should reject cache: [] as invalid (array instead of object)", () => {
        expect(() =>
          validateConfig(
            {
              plex: {
                cache: [],
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);
      });

      it("should reject cache: null as invalid", () => {
        expect(() =>
          validateConfig(
            {
              plex: {
                cache: null,
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);
      });
    });
  });

  describe("plex.auth validation", () => {
    it("round-trips every plex.auth field through the validator", () => {
      const config = validateConfig(
        {
          plex: {
            auth: {
              mode: "jwt",
              storePath: "/var/lib/rfmedia/plex-auth/store.json",
              deviceName: "workstation",
              refreshMarginSeconds: 900,
            },
          },
        },
        testConfigPath,
      );

      expect(config.plex?.auth).toEqual({
        mode: "jwt",
        storePath: "/var/lib/rfmedia/plex-auth/store.json",
        deviceName: "workstation",
        refreshMarginSeconds: 900,
      });
    });

    it("accepts an empty auth object and applies no defaults", () => {
      const config = validateConfig({ plex: { auth: {} } }, testConfigPath);

      expect(config.plex?.auth).toEqual({});
    });

    it('retains mode: "jwt" alongside plex.token at load time', () => {
      // The jwt/static conflict is raised at USE time as `ambiguous-credential`,
      // never here: loadConfig() warns and falls through to the NEXT search path
      // on ConfigError, which could silently select different credentials.
      const config = validateConfig(
        {
          plex: {
            token: "legacy-plex-token",
            auth: { mode: "jwt" },
          },
        },
        testConfigPath,
      );

      expect(config.plex?.token).toBe("legacy-plex-token");
      expect(config.plex?.auth?.mode).toBe("jwt");
    });

    describe("mode", () => {
      it.each(["static", "jwt"] as const)("accepts mode: %s", (mode) => {
        const config = validateConfig({ plex: { auth: { mode } } }, testConfigPath);

        expect(config.plex?.auth?.mode).toBe(mode);
      });

      it("rejects an unknown mode", () => {
        try {
          validateConfig({ plex: { auth: { mode: "oauth" } } }, testConfigPath);
          expect.unreachable("expected ConfigError");
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).message).toContain("Valid modes: static, jwt");
          expect((error as ConfigError).propertyPath).toBe("plex.auth.mode");
        }
      });

      it("rejects a non-string mode", () => {
        expect(() => validateConfig({ plex: { auth: { mode: 1 } } }, testConfigPath)).toThrow(
          ConfigError,
        );
      });
    });

    describe("storePath", () => {
      it("expands a leading tilde", () => {
        const config = validateConfig(
          { plex: { auth: { storePath: "~/.config/rfmedia/plex-auth/store.json" } } },
          testConfigPath,
        );

        expect(config.plex?.auth?.storePath).toBe(
          join(homedir(), ".config/rfmedia/plex-auth/store.json"),
        );
      });

      it("rejects an empty storePath", () => {
        try {
          validateConfig({ plex: { auth: { storePath: "   " } } }, testConfigPath);
          expect.unreachable("expected ConfigError");
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).propertyPath).toBe("plex.auth.storePath");
        }
      });
    });

    describe("deviceName", () => {
      it("accepts a non-empty device label", () => {
        const config = validateConfig(
          { plex: { auth: { deviceName: "workstation" } } },
          testConfigPath,
        );

        expect(config.plex?.auth?.deviceName).toBe("workstation");
      });

      it("rejects a non-string deviceName", () => {
        try {
          validateConfig({ plex: { auth: { deviceName: 42 } } }, testConfigPath);
          expect.unreachable("expected ConfigError");
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).propertyPath).toBe("plex.auth.deviceName");
        }
      });
    });

    describe("refreshMarginSeconds", () => {
      it.each([60, 300, 86_400])("accepts %d seconds (inside bounds)", (seconds) => {
        const config = validateConfig(
          { plex: { auth: { refreshMarginSeconds: seconds } } },
          testConfigPath,
        );

        expect(config.plex?.auth?.refreshMarginSeconds).toBe(seconds);
      });

      it.each([59, 86_401, 0, -1, 300.5, "300"])("rejects %p (outside bounds or type)", (value) => {
        try {
          validateConfig({ plex: { auth: { refreshMarginSeconds: value } } }, testConfigPath);
          expect.unreachable("expected ConfigError");
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).message).toContain("integer between 60 and 86400");
          expect((error as ConfigError).propertyPath).toBe("plex.auth.refreshMarginSeconds");
        }
      });
    });

    describe("auth type validation", () => {
      const nonObjectAuthValues: ReadonlyArray<readonly [string, unknown]> = [
        ["string", "jwt"],
        ["array", []],
        ["null", null],
      ];

      for (const [label, authRaw] of nonObjectAuthValues) {
        it(`rejects a non-object auth block (${label})`, () => {
          try {
            validateConfig({ plex: { auth: authRaw } }, testConfigPath);
            expect.unreachable("expected ConfigError");
          } catch (error) {
            expect(error).toBeInstanceOf(ConfigError);
            expect((error as ConfigError).message).toContain("Expected object for plex.auth");
            expect((error as ConfigError).propertyPath).toBe("plex.auth");
          }
        });
      }
    });
  });

  describe("plex paging and sync-on-copy validation", () => {
    it("retains all configured paging and sync-on-copy values", () => {
      const config = validateConfig(
        {
          plex: {
            pageSize: 250,
            syncRatingsOnCopy: true,
            syncOnCopyDefaults: {
              popmEmail: "user@example.com",
              vorbisScale: "stars",
            },
          },
        },
        testConfigPath,
      );

      expect(config.plex?.pageSize).toBe(250);
      expect(config.plex?.syncRatingsOnCopy).toBe(true);
      expect(config.plex?.syncOnCopyDefaults).toEqual({
        popmEmail: "user@example.com",
        vorbisScale: "stars",
      });
    });

    it("retains explicit false and an empty sync-on-copy defaults object", () => {
      const config = validateConfig(
        {
          plex: {
            syncRatingsOnCopy: false,
            syncOnCopyDefaults: {},
          },
        },
        testConfigPath,
      );

      expect(config.plex?.syncRatingsOnCopy).toBe(false);
      expect(config.plex?.syncOnCopyDefaults).toEqual({});
    });

    it.each([1, 1_000])("accepts pageSize boundary %d", (pageSize) => {
      expect(validateConfig({ plex: { pageSize } }, testConfigPath).plex?.pageSize).toBe(pageSize);
    });

    it.each([
      [{ pageSize: 0 }, "plex.pageSize"],
      [{ pageSize: 1_001 }, "plex.pageSize"],
      [{ pageSize: 1.5 }, "plex.pageSize"],
      [{ pageSize: "250" }, "plex.pageSize"],
      [{ syncRatingsOnCopy: "true" }, "plex.syncRatingsOnCopy"],
      [{ syncOnCopyDefaults: null }, "plex.syncOnCopyDefaults"],
      [{ syncOnCopyDefaults: [] }, "plex.syncOnCopyDefaults"],
      [{ syncOnCopyDefaults: { popmEmail: "" } }, "plex.syncOnCopyDefaults.popmEmail"],
      [{ syncOnCopyDefaults: { popmEmail: 123 } }, "plex.syncOnCopyDefaults.popmEmail"],
      [{ syncOnCopyDefaults: { vorbisScale: "ten" } }, "plex.syncOnCopyDefaults.vorbisScale"],
    ] as const)("rejects invalid Plex config %p at %s", (plex, propertyPath) => {
      try {
        validateConfig({ plex }, testConfigPath);
        expect.unreachable("expected ConfigError");
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).propertyPath).toBe(propertyPath);
      }
    });
  });

  describe("combined plex configuration", () => {
    it("should accept all valid plex sections together", () => {
      const config = validateConfig(
        {
          plex: {
            defaultFilters: {
              minPlays: 5,
              excludeGenres: ["Rock", "Pop"],
            },
            playlistDefaults: {
              smart: true,
              updateExisting: false,
            },
            cache: {
              enabled: true,
              ttlSeconds: 300,
            },
          },
        },
        testConfigPath,
      );

      expect(config.plex?.defaultFilters?.minPlays).toBe(5);
      expect(config.plex?.defaultFilters?.excludeGenres).toEqual(["Rock", "Pop"]);
      expect(config.plex?.playlistDefaults?.smart).toBe(true);
      expect(config.plex?.playlistDefaults?.updateExisting).toBe(false);
      expect(config.plex?.cache?.enabled).toBe(true);
      expect(config.plex?.cache?.ttlSeconds).toBe(300);
    });

    it("should handle partial plex configuration", () => {
      const config = validateConfig(
        {
          plex: {
            url: "http://localhost:32400",
            defaultFilters: {
              minPlays: 0,
            },
          },
        },
        testConfigPath,
      );

      expect(config.plex?.url).toBe("http://localhost:32400");
      expect(config.plex?.defaultFilters?.minPlays).toBe(0);
      expect(config.plex?.playlistDefaults).toBeUndefined();
      expect(config.plex?.cache).toBeUndefined();
    });
  });

  describe("interactive configuration validation", () => {
    describe("artistPageSize", () => {
      it("should accept artistPageSize: 20 as valid (default)", () => {
        const config = validateConfig(
          {
            interactive: {
              artistPageSize: 20,
            },
          },
          testConfigPath,
        );

        expect(config.interactive?.artistPageSize).toBe(20);
      });

      it("should accept artistPageSize: 5 as valid (minimum)", () => {
        const config = validateConfig(
          {
            interactive: {
              artistPageSize: 5,
            },
          },
          testConfigPath,
        );

        expect(config.interactive?.artistPageSize).toBe(5);
      });

      it("should accept artistPageSize: 100 as valid (maximum)", () => {
        const config = validateConfig(
          {
            interactive: {
              artistPageSize: 100,
            },
          },
          testConfigPath,
        );

        expect(config.interactive?.artistPageSize).toBe(100);
      });

      it("should accept artistPageSize: 50 as valid (mid-range)", () => {
        const config = validateConfig(
          {
            interactive: {
              artistPageSize: 50,
            },
          },
          testConfigPath,
        );

        expect(config.interactive?.artistPageSize).toBe(50);
      });

      it("should reject artistPageSize: 0 as invalid (below minimum)", () => {
        expect(() =>
          validateConfig(
            {
              interactive: {
                artistPageSize: 0,
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);

        try {
          validateConfig(
            {
              interactive: {
                artistPageSize: 0,
              },
            },
            testConfigPath,
          );
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).message).toContain("between 5 and 100");
          expect((error as ConfigError).propertyPath).toBe("interactive.artistPageSize");
        }
      });

      it("should reject artistPageSize: 4 as invalid (below minimum)", () => {
        expect(() =>
          validateConfig(
            {
              interactive: {
                artistPageSize: 4,
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);

        try {
          validateConfig(
            {
              interactive: {
                artistPageSize: 4,
              },
            },
            testConfigPath,
          );
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).message).toContain("between 5 and 100");
        }
      });

      it("should reject artistPageSize: 101 as invalid (above maximum)", () => {
        expect(() =>
          validateConfig(
            {
              interactive: {
                artistPageSize: 101,
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);

        try {
          validateConfig(
            {
              interactive: {
                artistPageSize: 101,
              },
            },
            testConfigPath,
          );
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).message).toContain("between 5 and 100");
        }
      });

      it("should reject artistPageSize: -1 as invalid (negative)", () => {
        expect(() =>
          validateConfig(
            {
              interactive: {
                artistPageSize: -1,
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);
      });

      it("should reject artistPageSize: 20.5 as invalid (not an integer)", () => {
        expect(() =>
          validateConfig(
            {
              interactive: {
                artistPageSize: 20.5,
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);

        try {
          validateConfig(
            {
              interactive: {
                artistPageSize: 20.5,
              },
            },
            testConfigPath,
          );
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).message).toContain("between 5 and 100");
        }
      });

      it('should reject artistPageSize: "20" as invalid (wrong type)', () => {
        expect(() =>
          validateConfig(
            {
              interactive: {
                artistPageSize: "20",
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);
      });
    });

    describe("albumPageSize", () => {
      it("should accept albumPageSize: 20 as valid (default)", () => {
        const config = validateConfig(
          {
            interactive: {
              albumPageSize: 20,
            },
          },
          testConfigPath,
        );

        expect(config.interactive?.albumPageSize).toBe(20);
      });

      it("should accept albumPageSize: 5 as valid (minimum)", () => {
        const config = validateConfig(
          {
            interactive: {
              albumPageSize: 5,
            },
          },
          testConfigPath,
        );

        expect(config.interactive?.albumPageSize).toBe(5);
      });

      it("should accept albumPageSize: 100 as valid (maximum)", () => {
        const config = validateConfig(
          {
            interactive: {
              albumPageSize: 100,
            },
          },
          testConfigPath,
        );

        expect(config.interactive?.albumPageSize).toBe(100);
      });

      it("should reject albumPageSize: 0 as invalid (below minimum)", () => {
        expect(() =>
          validateConfig(
            {
              interactive: {
                albumPageSize: 0,
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);

        try {
          validateConfig(
            {
              interactive: {
                albumPageSize: 0,
              },
            },
            testConfigPath,
          );
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).message).toContain("between 5 and 100");
          expect((error as ConfigError).propertyPath).toBe("interactive.albumPageSize");
        }
      });

      it("should reject albumPageSize: 101 as invalid (above maximum)", () => {
        expect(() =>
          validateConfig(
            {
              interactive: {
                albumPageSize: 101,
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);
      });

      it("should reject albumPageSize: -10 as invalid (negative)", () => {
        expect(() =>
          validateConfig(
            {
              interactive: {
                albumPageSize: -10,
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);
      });

      it("should reject albumPageSize: 15.7 as invalid (not an integer)", () => {
        expect(() =>
          validateConfig(
            {
              interactive: {
                albumPageSize: 15.7,
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);
      });
    });

    describe("trackPageSize", () => {
      it("should accept trackPageSize: 25 as valid (default)", () => {
        const config = validateConfig(
          {
            interactive: {
              trackPageSize: 25,
            },
          },
          testConfigPath,
        );

        expect(config.interactive?.trackPageSize).toBe(25);
      });

      it("should accept trackPageSize: 5 as valid (minimum)", () => {
        const config = validateConfig(
          {
            interactive: {
              trackPageSize: 5,
            },
          },
          testConfigPath,
        );

        expect(config.interactive?.trackPageSize).toBe(5);
      });

      it("should accept trackPageSize: 100 as valid (maximum)", () => {
        const config = validateConfig(
          {
            interactive: {
              trackPageSize: 100,
            },
          },
          testConfigPath,
        );

        expect(config.interactive?.trackPageSize).toBe(100);
      });

      it("should reject trackPageSize: 3 as invalid (below minimum)", () => {
        expect(() =>
          validateConfig(
            {
              interactive: {
                trackPageSize: 3,
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);

        try {
          validateConfig(
            {
              interactive: {
                trackPageSize: 3,
              },
            },
            testConfigPath,
          );
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).message).toContain("between 5 and 100");
          expect((error as ConfigError).propertyPath).toBe("interactive.trackPageSize");
        }
      });

      it("should reject trackPageSize: 200 as invalid (above maximum)", () => {
        expect(() =>
          validateConfig(
            {
              interactive: {
                trackPageSize: 200,
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);
      });

      it("should reject trackPageSize: -5 as invalid (negative)", () => {
        expect(() =>
          validateConfig(
            {
              interactive: {
                trackPageSize: -5,
              },
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);
      });
    });

    describe("empty interactive object", () => {
      it("should accept empty interactive object and apply defaults", () => {
        const config = validateConfig(
          {
            interactive: {},
          },
          testConfigPath,
        );

        // Defaults should be applied
        expect(config.interactive?.artistPageSize).toBe(20);
        expect(config.interactive?.albumPageSize).toBe(20);
        expect(config.interactive?.trackPageSize).toBe(25);
      });
    });

    describe("partial interactive configuration", () => {
      it("should accept partial config with only artistPageSize", () => {
        const config = validateConfig(
          {
            interactive: {
              artistPageSize: 30,
            },
          },
          testConfigPath,
        );

        expect(config.interactive?.artistPageSize).toBe(30);
        // Defaults should be applied for missing fields
        expect(config.interactive?.albumPageSize).toBe(20);
        expect(config.interactive?.trackPageSize).toBe(25);
      });

      it("should accept partial config with only albumPageSize", () => {
        const config = validateConfig(
          {
            interactive: {
              albumPageSize: 15,
            },
          },
          testConfigPath,
        );

        expect(config.interactive?.artistPageSize).toBe(20);
        expect(config.interactive?.albumPageSize).toBe(15);
        expect(config.interactive?.trackPageSize).toBe(25);
      });

      it("should accept partial config with artistPageSize and trackPageSize", () => {
        const config = validateConfig(
          {
            interactive: {
              artistPageSize: 10,
              trackPageSize: 50,
            },
          },
          testConfigPath,
        );

        expect(config.interactive?.artistPageSize).toBe(10);
        expect(config.interactive?.albumPageSize).toBe(20); // default
        expect(config.interactive?.trackPageSize).toBe(50);
      });
    });

    describe("combined interactive configuration", () => {
      it("should accept all valid interactive properties together", () => {
        const config = validateConfig(
          {
            interactive: {
              artistPageSize: 15,
              albumPageSize: 25,
              trackPageSize: 30,
            },
          },
          testConfigPath,
        );

        expect(config.interactive?.artistPageSize).toBe(15);
        expect(config.interactive?.albumPageSize).toBe(25);
        expect(config.interactive?.trackPageSize).toBe(30);
      });

      it("should accept all properties at boundary values", () => {
        const config = validateConfig(
          {
            interactive: {
              artistPageSize: 5,
              albumPageSize: 100,
              trackPageSize: 50,
            },
          },
          testConfigPath,
        );

        expect(config.interactive?.artistPageSize).toBe(5);
        expect(config.interactive?.albumPageSize).toBe(100);
        expect(config.interactive?.trackPageSize).toBe(50);
      });
    });

    describe("interactive type validation", () => {
      it('should reject interactive: "string" as invalid', () => {
        expect(() =>
          validateConfig(
            {
              interactive: "string",
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);
      });

      it("should reject interactive: [] as invalid (array instead of object)", () => {
        expect(() =>
          validateConfig(
            {
              interactive: [],
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);
      });

      it("should reject interactive: null as invalid", () => {
        expect(() =>
          validateConfig(
            {
              interactive: null,
            },
            testConfigPath,
          ),
        ).toThrow(ConfigError);
      });
    });

    describe("missing interactive section", () => {
      it("should accept config without interactive section", () => {
        const config = validateConfig(
          {
            copy: {
              workers: 4,
            },
          },
          testConfigPath,
        );

        expect(config.interactive).toBeUndefined();
      });

      it("should accept completely empty config", () => {
        const config = validateConfig({}, testConfigPath);

        expect(config.interactive).toBeUndefined();
      });
    });
  });

  describe("getInteractiveConfig", () => {
    describe("with null or undefined config", () => {
      it("should return defaults when config is null", () => {
        const result = getInteractiveConfig(null);

        expect(result).toEqual({
          artistPageSize: 20,
          albumPageSize: 20,
          trackPageSize: 25,
        });
      });

      it("should return defaults when config is undefined", () => {
        const result = getInteractiveConfig(undefined);

        expect(result).toEqual({
          artistPageSize: 20,
          albumPageSize: 20,
          trackPageSize: 25,
        });
      });
    });

    describe("with empty config", () => {
      it("should return defaults when config has no interactive section", () => {
        const result = getInteractiveConfig({});

        expect(result).toEqual({
          artistPageSize: 20,
          albumPageSize: 20,
          trackPageSize: 25,
        });
      });

      it("should return defaults when interactive section is empty", () => {
        const result = getInteractiveConfig({
          interactive: {} as any,
        });

        expect(result).toEqual({
          artistPageSize: 20,
          albumPageSize: 20,
          trackPageSize: 25,
        });
      });
    });

    describe("with partial config", () => {
      it("should merge provided artistPageSize with defaults", () => {
        const result = getInteractiveConfig({
          interactive: {
            artistPageSize: 30,
            albumPageSize: 20,
            trackPageSize: 25,
          },
        });

        expect(result).toEqual({
          artistPageSize: 30,
          albumPageSize: 20,
          trackPageSize: 25,
        });
      });

      it("should merge provided albumPageSize with defaults", () => {
        const result = getInteractiveConfig({
          interactive: {
            artistPageSize: 20,
            albumPageSize: 15,
            trackPageSize: 25,
          },
        });

        expect(result).toEqual({
          artistPageSize: 20,
          albumPageSize: 15,
          trackPageSize: 25,
        });
      });

      it("should merge provided trackPageSize with defaults", () => {
        const result = getInteractiveConfig({
          interactive: {
            artistPageSize: 20,
            albumPageSize: 20,
            trackPageSize: 50,
          },
        });

        expect(result).toEqual({
          artistPageSize: 20,
          albumPageSize: 20,
          trackPageSize: 50,
        });
      });

      it("should handle multiple overrides", () => {
        const result = getInteractiveConfig({
          interactive: {
            artistPageSize: 10,
            albumPageSize: 15,
            trackPageSize: 40,
          },
        });

        expect(result).toEqual({
          artistPageSize: 10,
          albumPageSize: 15,
          trackPageSize: 40,
        });
      });
    });

    describe("with complete config", () => {
      it("should use all provided values", () => {
        const result = getInteractiveConfig({
          interactive: {
            artistPageSize: 5,
            albumPageSize: 100,
            trackPageSize: 75,
          },
        });

        expect(result).toEqual({
          artistPageSize: 5,
          albumPageSize: 100,
          trackPageSize: 75,
        });
      });

      it("should use boundary values correctly", () => {
        const result = getInteractiveConfig({
          interactive: {
            artistPageSize: 5,
            albumPageSize: 100,
            trackPageSize: 100,
          },
        });

        expect(result).toEqual({
          artistPageSize: 5,
          albumPageSize: 100,
          trackPageSize: 100,
        });
      });
    });

    describe("return type consistency", () => {
      it("should always return a complete InteractiveConfig object", () => {
        const result = getInteractiveConfig(null);

        expect(result).toHaveProperty("artistPageSize");
        expect(result).toHaveProperty("albumPageSize");
        expect(result).toHaveProperty("trackPageSize");
        expect(typeof result.artistPageSize).toBe("number");
        expect(typeof result.albumPageSize).toBe("number");
        expect(typeof result.trackPageSize).toBe("number");
      });

      it("should return readonly interface (type safety)", () => {
        const result = getInteractiveConfig({
          interactive: { artistPageSize: 20, albumPageSize: 20, trackPageSize: 25 },
        });

        // TypeScript should prevent mutation, but at runtime we can verify the structure
        expect(Object.isFrozen(result)).toBe(false); // We don't freeze, but the type is readonly
        expect(result.artistPageSize).toBe(20);
      });
    });

    describe("with other config sections", () => {
      it("should work correctly when other config sections are present", () => {
        const result = getInteractiveConfig({
          copy: {
            workers: 4,
          } as any,
          interactive: {
            artistPageSize: 25,
            albumPageSize: 20,
            trackPageSize: 25,
          },
        });

        expect(result).toEqual({
          artistPageSize: 25,
          albumPageSize: 20,
          trackPageSize: 25,
        });
      });

      it("should ignore other config sections", () => {
        const result = getInteractiveConfig({
          plex: {
            url: "http://localhost:32400",
          } as any,
          copy: {
            workers: 8,
          } as any,
          interactive: {
            artistPageSize: 12,
            albumPageSize: 18,
            trackPageSize: 22,
          },
        });

        expect(result).toEqual({
          artistPageSize: 12,
          albumPageSize: 18,
          trackPageSize: 22,
        });
      });
    });
  });
});

/**
 * Integration tests for secrets injection in config loading.
 *
 * Tests that loadConfig() correctly integrates with injectSecrets():
 * - Template variables are resolved from environment
 * - Missing variables throw SecretsInjectionError
 * - Multiple templates and mixed content work correctly
 *
 * Uses vi.stubEnv() for environment variable mocking.
 */
describe("loadConfig with secrets injection", () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Create a unique temp directory for each test
    testDir = join(
      tmpdir(),
      `rfmedia-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
    // Save original cwd and change to test directory
    originalCwd = process.cwd();
    process.chdir(testDir);

    // Configure pathExists mock to use real filesystem for config loading tests
    // This allows loadConfig() to find the config files we create
    const { access } = await import("node:fs/promises");
    mockFilesystem.pathExists.mockImplementation(async (path: string) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    });
  });

  afterEach(async () => {
    // Clear config cache to prevent state leaking between tests
    clearConfigCache();
    // Restore original cwd before cleanup
    process.chdir(originalCwd);
    // Clean up temp directory
    await rm(testDir, { recursive: true, force: true });
    // Unstub all environment variables
    vi.unstubAllEnvs();
  });

  describe("template resolution in config", () => {
    it("should resolve single template variable from environment", async () => {
      // Set environment variable
      vi.stubEnv("PLEX_TOKEN", "test-token-12345");

      // Create config with template
      const configContent = `
plex:
  url: "https://plex.example.com"
  token: "{{ PLEX_TOKEN }}"
`;
      await writeFile(join(testDir, ".rfmedia.yaml"), configContent, "utf-8");

      // Load config
      const result = await loadConfig();

      // Verify token was resolved
      expect(result.config.plex?.token).toBe("test-token-12345");
      expect(result.config.plex?.url).toBe("https://plex.example.com");
    });

    it("should resolve template without whitespace: {{VAR}}", async () => {
      vi.stubEnv("API_KEY", "secret-key");

      const configContent = `
plex:
  token: "{{API_KEY}}"
`;
      await writeFile(join(testDir, ".rfmedia.yaml"), configContent, "utf-8");

      const result = await loadConfig();

      expect(result.config.plex?.token).toBe("secret-key");
    });

    it("should resolve template with extra whitespace: {{  VAR  }}", async () => {
      vi.stubEnv("TOKEN", "my-value");

      const configContent = `
plex:
  token: "{{  TOKEN  }}"
`;
      await writeFile(join(testDir, ".rfmedia.yaml"), configContent, "utf-8");

      const result = await loadConfig();

      expect(result.config.plex?.token).toBe("my-value");
    });
  });

  describe("missing template variable", () => {
    it("should throw SecretsInjectionError for missing variable", async () => {
      // Do NOT set MISSING_VAR environment variable
      const configContent = `
plex:
  token: "{{ MISSING_VAR }}"
`;
      await writeFile(join(testDir, ".rfmedia.yaml"), configContent, "utf-8");

      // loadConfig should throw SecretsInjectionError and halt execution immediately
      await expect(loadConfig()).rejects.toThrow(SecretsInjectionError);

      // Verify error properties
      try {
        await loadConfig();
        expect.fail("Expected SecretsInjectionError to be thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(SecretsInjectionError);
        expect((error as SecretsInjectionError).variableName).toBe("MISSING_VAR");
        expect((error as SecretsInjectionError).configPath).toContain(".rfmedia.yaml");
        expect((error as SecretsInjectionError).message).toContain("MISSING_VAR");
      }
    });

    it("should include variable name in error when thrown directly", async () => {
      // Test that SecretsInjectionError has correct properties
      // We test this directly since loadConfig catches and logs errors
      const error = new SecretsInjectionError("MY_SECRET", "/path/to/config.yaml");

      expect(error.variableName).toBe("MY_SECRET");
      expect(error.configPath).toBe("/path/to/config.yaml");
      expect(error.message).toContain("'MY_SECRET'");
      expect(error.message).toContain("in /path/to/config.yaml");
    });

    it("eagerly resolves discovery credentials whenever config is loaded", async () => {
      vi.stubEnv("LASTFM_API_KEY", undefined);
      await writeFile(
        join(testDir, ".rfmedia.yaml"),
        `
global:
  debug: false
discovery:
  lastfm:
    apiKey: "{{ LASTFM_API_KEY }}"
`,
        "utf-8",
      );

      await expect(loadConfig()).rejects.toMatchObject({
        variableName: "LASTFM_API_KEY",
      });
    });

    it("loads offline origins without resolving or caching missing credential templates", async () => {
      vi.stubEnv("PLEX_URL", "https://plex.example.com");
      vi.stubEnv("LIDARR_URL", "https://lidarr.example.com");
      vi.stubEnv("PLEX_TOKEN", undefined);
      vi.stubEnv("LIDARR_API_KEY", undefined);
      await writeFile(
        join(testDir, ".rfmedia.yaml"),
        `
plex:
  url: "{{ PLEX_URL }}"
  token: "{{ PLEX_TOKEN }}"
lidarr:
  baseUrl: "{{ LIDARR_URL }}"
  apiKey: "{{ LIDARR_API_KEY }}"
`,
        "utf-8",
      );

      const result = await loadConfig({ resolveSecrets: false });

      expect(result.config.plex).toMatchObject({
        url: "https://plex.example.com",
        token: "{{ PLEX_TOKEN }}",
      });
      expect(result.config.lidarr).toMatchObject({
        baseUrl: "https://lidarr.example.com",
        apiKey: "{{ LIDARR_API_KEY }}",
      });
      await expect(loadConfig()).rejects.toMatchObject({
        variableName: "PLEX_TOKEN",
      });
    });

    it("preserves unavailable offline origin templates for explicit CLI overrides", async () => {
      vi.stubEnv("PLEX_URL", undefined);
      vi.stubEnv("LIDARR_URL", undefined);
      await writeFile(
        join(testDir, ".rfmedia.yaml"),
        `
plex:
  url: "{{ PLEX_URL }}"
lidarr:
  baseUrl: "{{ LIDARR_URL }}"
tracking:
  database: "/var/lib/rfmedia/tracking.db"
`,
        "utf-8",
      );

      const result = await loadConfig({ resolveSecrets: false });

      expect(result.config.plex?.url).toBeUndefined();
      expect(result.config.lidarr?.baseUrl).toBeUndefined();
      expect(result.config.tracking?.database).toBe("/var/lib/rfmedia/tracking.db");
      await expect(loadConfig()).rejects.toMatchObject({
        variableName: "PLEX_URL",
      });
    });
  });

  describe("multiple templates", () => {
    it("should resolve all template fields correctly", async () => {
      vi.stubEnv("PLEX_URL", "https://my-plex.example.com");
      vi.stubEnv("PLEX_TOKEN", "token-abc123");
      vi.stubEnv("DB_PATH", "/data/tracking.db");

      const configContent = `
plex:
  url: "{{ PLEX_URL }}"
  token: "{{ PLEX_TOKEN }}"
tracking:
  database: "{{ DB_PATH }}"
`;
      await writeFile(join(testDir, ".rfmedia.yaml"), configContent, "utf-8");

      const result = await loadConfig();

      expect(result.config.plex?.url).toBe("https://my-plex.example.com");
      expect(result.config.plex?.token).toBe("token-abc123");
      expect(result.config.tracking?.database).toBe("/data/tracking.db");
    });

    it("should resolve templates in array syntax", async () => {
      vi.stubEnv("LIB_PATH_1", "/music/library1");
      vi.stubEnv("LIB_PATH_2", "/music/library2");

      // Using a valid config structure with arrays
      const configContent = `
plex:
  libraries:
    - path: "{{ LIB_PATH_1 }}"
      library: "Music1"
    - path: "{{ LIB_PATH_2 }}"
      library: "Music2"
`;
      await writeFile(join(testDir, ".rfmedia.yaml"), configContent, "utf-8");

      const result = await loadConfig();

      expect(result.config.plex?.libraries).toHaveLength(2);
      expect(result.config.plex?.libraries?.[0]?.path).toBe("/music/library1");
      expect(result.config.plex?.libraries?.[1]?.path).toBe("/music/library2");
    });
  });

  describe("mixed content", () => {
    it("should handle config with both templates and plain values", async () => {
      vi.stubEnv("PLEX_TOKEN", "secret-token");

      const configContent = `
plex:
  url: "https://plex.hardcoded.com"
  token: "{{ PLEX_TOKEN }}"
  scanAfterCopy: true
  libraryName: "Music"
copy:
  workers: 4
  hardlink: false
tracking:
  useLegacy: false
`;
      await writeFile(join(testDir, ".rfmedia.yaml"), configContent, "utf-8");

      const result = await loadConfig();

      // Template resolved
      expect(result.config.plex?.token).toBe("secret-token");
      // Plain values preserved
      expect(result.config.plex?.url).toBe("https://plex.hardcoded.com");
      expect(result.config.plex?.scanAfterCopy).toBe(true);
      expect(result.config.plex?.libraryName).toBe("Music");
      expect(result.config.copy?.workers).toBe(4);
      expect(result.config.copy?.hardlink).toBe(false);
      expect(result.config.tracking?.useLegacy).toBe(false);
    });

    it("should preserve numeric values from templates", async () => {
      vi.stubEnv("PORT", "32400");

      // Port is not a valid plex config field, but we can test with workers
      const configContent = `
copy:
  workers: {{ PORT }}
`;
      await writeFile(join(testDir, ".rfmedia.yaml"), configContent, "utf-8");

      const result = await loadConfig();

      // YAML parses unquoted numbers as numbers, but template produces string "32400"
      // which YAML then parses as a number
      expect(result.config.copy?.workers).toBe(32400);
    });

    it("should resolve empty string from env but fail validation for required fields", async () => {
      // Empty string is valid for template resolution but plex.token requires non-empty
      vi.stubEnv("EMPTY_VALUE", "");

      const configContent = `
plex:
  token: "{{ EMPTY_VALUE }}"
`;
      await writeFile(join(testDir, ".rfmedia.yaml"), configContent, "utf-8");

      // Restrict pathExists to only find files within testDir, preventing loadConfig
      // from falling back to the real user config at ~/.config/rfmedia/config.yaml
      const { access } = await import("node:fs/promises");
      mockFilesystem.pathExists.mockImplementation(async (filePath: string) => {
        if (!filePath.startsWith(testDir)) {
          return false;
        }
        try {
          await access(filePath);
          return true;
        } catch {
          return false;
        }
      });

      // loadConfig catches the ConfigError from validation and continues
      const result = await loadConfig();

      // Config should be empty since validation failed (token must be non-empty string)
      // and no fallback config was found
      expect(result.config.plex?.token).toBeUndefined();
    });
  });

  describe("authoritative failure mode", () => {
    it("rejects invalid highest-precedence overrides instead of falling through", async () => {
      await writeFile(
        join(testDir, ".rfmedia.yaml"),
        `
policy:
  overrides:
    "stale-monitoring-cleanup:artist:233":
      action: force
      evidenceFingerprint: "sha256:${"a".repeat(64)}"
      reason: "Reviewed"
`,
        "utf-8",
      );
      await writeFile(
        join(testDir, ".rfmedia.json"),
        JSON.stringify({ plex: { url: "https://fallback.example.com" } }),
        "utf-8",
      );

      await expect(loadConfig({ failOnInvalid: true })).rejects.toMatchObject({
        propertyPath: 'policy.overrides["stale-monitoring-cleanup:artist:233"].action',
      });

      const permissive = await loadConfig();
      expect(permissive.config.plex?.url).toBe("https://fallback.example.com");
      expect(permissive.loadedFrom).toBe(join(testDir, ".rfmedia.json"));
    });

    it("rejects malformed authoritative YAML instead of reading a lower-priority file", async () => {
      await writeFile(join(testDir, ".rfmedia.yaml"), "policy: [", "utf-8");
      await writeFile(
        join(testDir, ".rfmedia.json"),
        JSON.stringify({ plex: { url: "https://fallback.example.com" } }),
        "utf-8",
      );

      await expect(loadConfig({ failOnInvalid: true })).rejects.toBeDefined();

      const permissive = await loadConfig();
      expect(permissive.loadedFrom).toBe(join(testDir, ".rfmedia.json"));
    });

    it("rejects a dangling authoritative symlink instead of falling through", async () => {
      const authoritativePath = join(testDir, ".rfmedia.yaml");
      await symlink(join(testDir, "missing-policy.yaml"), authoritativePath);
      await writeFile(
        join(testDir, ".rfmedia.json"),
        JSON.stringify({ plex: { url: "https://fallback.example.com" } }),
        "utf-8",
      );

      await expect(loadConfig({ failOnInvalid: true })).rejects.toMatchObject({
        name: "ConfigError",
        configPath: authoritativePath,
        message: `Unable to read config file: ${authoritativePath}`,
      });

      const permissive = await loadConfig();
      expect(permissive.loadedFrom).toBe(join(testDir, ".rfmedia.json"));
    });

    it.each([
      ["YAML", ".rfmedia.yaml", 'plex:\n  token: "{{ POLICY_PARSE_SECRET }}"\n  url: ['],
      ["JSON", ".rfmedia.json", '{"plex":{"token":"{{ POLICY_PARSE_SECRET }}","url":}'],
    ])("sanitizes strict malformed %s after secret injection", async (format, name, content) => {
      const authoritativePath = join(testDir, name);
      const secret = "resolved-parser-secret-sentinel";
      vi.stubEnv("POLICY_PARSE_SECRET", secret);
      await writeFile(authoritativePath, content, "utf-8");

      try {
        await loadConfig({ failOnInvalid: true });
        expect.unreachable("expected malformed authoritative config to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect(error).toMatchObject({
          configPath: authoritativePath,
          message: `Invalid ${format} in config file: ${authoritativePath}`,
        });
        expect(String(error)).not.toContain(secret);
        expect((error as Error).stack).not.toContain(secret);
        expect((error as Error & { cause?: unknown }).cause).toBeUndefined();

        const debugOutput = vi.spyOn(console, "error").mockImplementation(() => undefined);
        setDebugMode(true);
        try {
          outputFormattedError(formatError(error as Error));
          expect(debugOutput.mock.calls.flat().join("\n")).not.toContain(secret);
        } finally {
          setDebugMode(false);
          debugOutput.mockRestore();
        }
      }
    });

    it("rejects an unresolved authoritative template while permissive loading keeps warning", async () => {
      const authoritativePath = join(testDir, ".rfmedia.yaml");
      await writeFile(
        authoritativePath,
        `
plex:
  token: "{{ INVALID NAME }}"
`,
        "utf-8",
      );
      await writeFile(
        join(testDir, ".rfmedia.json"),
        JSON.stringify({ plex: { token: "fallback-token" } }),
        "utf-8",
      );

      await expect(loadConfig({ failOnInvalid: true })).rejects.toMatchObject({
        name: "ConfigError",
        configPath: authoritativePath,
      });

      const permissive = await loadConfig();
      expect(permissive.config.plex?.token).toBe("{{ INVALID NAME }}");
      expect(permissive.loadedFrom).toBe(authoritativePath);
    });
  });

  describe("JSON config format", () => {
    it("should resolve templates in JSON config files", async () => {
      vi.stubEnv("PLEX_TOKEN", "json-token");

      const configContent = JSON.stringify({
        plex: {
          url: "https://plex.example.com",
          token: "{{ PLEX_TOKEN }}",
        },
      });
      await writeFile(join(testDir, ".rfmedia.json"), configContent, "utf-8");

      const result = await loadConfig();

      expect(result.config.plex?.token).toBe("json-token");
    });
  });
});

/**
 * Config cache behavior tests.
 *
 * Tests verify that loadConfig() caches results using mtime+size-based
 * invalidation via the config cache in loaded-config.ts.
 *
 * Uses fully mocked filesystem (pathExists, readFile, stat) to control
 * cache behavior precisely.
 */
describe("loadConfig caching", () => {
  const validYaml = `plex:\n  url: "http://localhost:32400"\n  token: "test-token"`;

  function createStat(mtimeMs: number, size: number): Stats {
    return { mtimeMs, size } as Stats;
  }

  beforeEach(() => {
    vi.clearAllMocks();

    // Override stat and readFile to use test-specific mocks (not real fs)
    mockFsPromises.stat.mockResolvedValue(createStat(1000, 500));
    mockFsPromises.readFile.mockResolvedValue(validYaml);

    // pathExists: only the first search path returns true
    mockFilesystem.pathExists.mockImplementation(async (path: string) => {
      return path === join(process.cwd(), ".rfmedia.yaml");
    });
  });

  afterEach(() => {
    clearConfigCache();
    // Restore stat and readFile to real implementations for other test suites
    // (vi.clearAllMocks in next beforeEach handles this since the mock factory
    //  sets real implementations, but explicit clearConfigCache is critical)
  });

  it("returns cached result on unchanged file", async () => {
    const first = await loadConfig();
    const second = await loadConfig();

    // Both calls should return valid config
    expect(first.config.plex?.token).toBe("test-token");
    expect(second.config.plex?.token).toBe("test-token");

    // readFile called once (second call used cache)
    expect(mockFsPromises.readFile).toHaveBeenCalledTimes(1);

    // pathExists called once for file discovery (second call skipped entirely)
    expect(mockFilesystem.pathExists).toHaveBeenCalledTimes(1);
  });

  it("re-reads file when mtime changes", async () => {
    mockFsPromises.stat
      .mockResolvedValueOnce(createStat(1000, 500)) // updateConfigCache after first load
      .mockResolvedValueOnce(createStat(2000, 500)) // isConfigCacheValid (mtime changed)
      .mockResolvedValueOnce(createStat(2000, 500)); // updateConfigCache after re-read

    await loadConfig();
    await loadConfig();

    expect(mockFsPromises.readFile).toHaveBeenCalledTimes(2);
  });

  it("re-reads file when size changes", async () => {
    mockFsPromises.stat
      .mockResolvedValueOnce(createStat(1000, 500)) // updateConfigCache after first load
      .mockResolvedValueOnce(createStat(1000, 600)) // isConfigCacheValid (size changed)
      .mockResolvedValueOnce(createStat(1000, 600)); // updateConfigCache after re-read

    await loadConfig();
    await loadConfig();

    expect(mockFsPromises.readFile).toHaveBeenCalledTimes(2);
  });

  it("clearConfigCache forces re-read", async () => {
    await loadConfig();

    clearConfigCache();

    await loadConfig();

    // readFile called twice even though mtime/size unchanged
    expect(mockFsPromises.readFile).toHaveBeenCalledTimes(2);
  });

  it("does not cache when no config file found", async () => {
    // All pathExists return false (no config file found)
    mockFilesystem.pathExists.mockResolvedValue(false);

    const first = await loadConfig();
    const second = await loadConfig();

    // Both should return empty config
    expect(first.config).toEqual({});
    expect(second.config).toEqual({});

    // pathExists search happens both times (no caching of "not found")
    // getConfigSearchPaths returns 12 paths, checked each time
    const totalPathExistsCalls = mockFilesystem.pathExists.mock.calls.length;
    expect(totalPathExistsCalls).toBe(24); // 12 paths * 2 calls
  });

  it("stat failure treated as cache miss", async () => {
    // First load succeeds normally
    await loadConfig();

    // Mock stat to throw ENOENT for the cache validity check
    const enoentError = Object.assign(new Error("ENOENT: no such file or directory"), {
      code: "ENOENT",
    });
    mockFsPromises.stat
      .mockRejectedValueOnce(enoentError) // isConfigCacheValid fails
      .mockResolvedValueOnce(createStat(1000, 500)); // updateConfigCache after re-read

    // Second load should fall through to full load (not crash)
    const result = await loadConfig();

    expect(result.config.plex?.token).toBe("test-token");
    expect(mockFsPromises.readFile).toHaveBeenCalledTimes(2);
  });

  it("strict loading bypasses a valid permissive cache entry", async () => {
    await loadConfig();
    mockFsPromises.readFile.mockResolvedValue(`
policy:
  overrides:
    "stale-monitoring-cleanup:artist:233":
      action: force
      evidenceFingerprint: "sha256:${"a".repeat(64)}"
      reason: "Reviewed"
`);

    await expect(loadConfig({ failOnInvalid: true })).rejects.toMatchObject({
      propertyPath: 'policy.overrides["stale-monitoring-cleanup:artist:233"].action',
    });
    expect(mockFsPromises.readFile).toHaveBeenCalledTimes(2);
  });

  it("strict loading does not populate the permissive cache", async () => {
    await loadConfig({ failOnInvalid: true });
    await loadConfig();

    expect(mockFsPromises.readFile).toHaveBeenCalledTimes(2);
  });

  it("strict loading surfaces non-ENOENT discovery failures with the candidate path", async () => {
    const authoritativePath = join(process.cwd(), ".rfmedia.yaml");
    const accessError = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    mockFsPromises.readFile.mockRejectedValueOnce(accessError);

    await expect(loadConfig({ failOnInvalid: true })).rejects.toMatchObject({
      name: "ConfigError",
      configPath: authoritativePath,
      message: `Unable to read config file: ${authoritativePath}`,
      cause: accessError,
    });
    expect(mockFilesystem.pathExists).not.toHaveBeenCalled();
  });

  it("strict loading skips only ENOENT and reads the next candidate", async () => {
    const missing = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    mockFsPromises.readFile.mockRejectedValueOnce(missing).mockResolvedValueOnce(validYaml);

    const result = await loadConfig({ failOnInvalid: true });

    expect(result.loadedFrom).toBe(join(process.cwd(), ".rfmedia.yml"));
    expect(result.config.plex?.token).toBe("test-token");
    expect(mockFilesystem.pathExists).not.toHaveBeenCalled();
  });
});
