import { describe, expect, it } from "vitest";

import type { LidarrConfiguredPresetPack } from "../../types/config.js";
import type {
  LidarrPresetCustomFormatDefinition,
  LidarrPresetLiveFormatScore,
  LidarrPresetPack,
  LidarrPresetQualityProfileDefinition,
} from "../../types/lidarr-presets.js";
import {
  BUILTIN_LIDARR_PRESET_PACKS,
  LIDARR_PRESET_SUPPORTED_FIXTURE_V1,
  assertLidarrPresetCompatible,
  buildLidarrPresetQualityProfileInput,
  createLidarrPresetDiff,
  resolveLidarrPresetPack,
  validateLidarrPresetPack,
  type LidarrPresetLiveState,
} from "./profile-presets.js";

function asConfiguredPack(pack: LidarrPresetPack): LidarrConfiguredPresetPack {
  return {
    version: pack.version,
    description: pack.description,
    assumptions: pack.assumptions,
    consequences: pack.consequences,
    capabilities: pack.capabilities,
    customFormats: pack.customFormats,
    qualityProfiles: pack.qualityProfiles,
    naming: pack.naming,
  };
}

function makeCustomFormatDefinition(
  pack: LidarrPresetPack,
  id = 501,
): LidarrPresetCustomFormatDefinition {
  const format = pack.customFormats[0]!;
  return {
    ...structuredClone(format),
    id,
    specifications: format.specifications.map((specification, index) => ({
      ...structuredClone(specification),
      id: id * 10 + index + 1,
    })),
  };
}

function withFormatItems(
  state: LidarrPresetLiveState,
  formatItems: readonly LidarrPresetLiveFormatScore[],
): LidarrPresetLiveState {
  return {
    ...state,
    qualityProfileSchema: {
      ...state.qualityProfileSchema,
      formatItems,
    },
  };
}

function makeEmptyState(): LidarrPresetLiveState {
  return {
    capabilities: LIDARR_PRESET_SUPPORTED_FIXTURE_V1.capabilities,
    customFormatSchema: LIDARR_PRESET_SUPPORTED_FIXTURE_V1.customFormatSchema,
    customFormats: [],
    qualityProfileSchema: LIDARR_PRESET_SUPPORTED_FIXTURE_V1.qualityProfileSchema,
    qualityProfiles: [],
    naming: LIDARR_PRESET_SUPPORTED_FIXTURE_V1.naming,
  };
}

function makeConvergedState(pack: LidarrPresetPack): LidarrPresetLiveState {
  const customFormat = makeCustomFormatDefinition(pack);
  const state = withFormatItems(makeEmptyState(), [
    {
      customFormat: { id: customFormat.id, name: customFormat.name },
      score: 0,
    },
  ]);
  const profileInput = buildLidarrPresetQualityProfileInput(
    pack.qualityProfiles[0]!,
    state.qualityProfileSchema,
    undefined,
  );
  const qualityProfile: LidarrPresetQualityProfileDefinition = {
    ...profileInput,
    id: 601,
  };
  return {
    ...state,
    customFormats: [customFormat],
    qualityProfiles: [qualityProfile],
    naming: { id: 1, ...structuredClone(pack.naming) },
  };
}

describe("Lidarr profile presets", () => {
  it("freezes the approved fixture evidence and exact built-in order", () => {
    expect(LIDARR_PRESET_SUPPORTED_FIXTURE_V1.evidence).toEqual({
      openApiUpstreamCommit: "3e2858439ff35b372d0af00bcea1b0a357572d26",
      qualitySource:
        "Lidarr/Lidarr@d4c72f8ee93113ce82321b78c3365dbaf435f1b8:src/NzbDrone.Core/Qualities/Quality.cs",
      namingSource:
        "Lidarr/Lidarr@d4c72f8ee93113ce82321b78c3365dbaf435f1b8:src/NzbDrone.Core/Organizer/NamingConfig.cs",
    });
    expect(BUILTIN_LIDARR_PRESET_PACKS.map(({ ref }) => ref)).toEqual([
      "builtin:balanced",
      "builtin:lossless",
      "builtin:space-saver",
    ]);
    expect(BUILTIN_LIDARR_PRESET_PACKS.every((pack) => Object.isFrozen(pack))).toBe(true);
    expect(BUILTIN_LIDARR_PRESET_PACKS.map(({ digest }) => digest)).toEqual([
      "01083817a0ba42c29d3993e7d275caead6709f9e2e5bd5a518973d37d941207d",
      "de08001183d18276a071cdc7b1058458f51aba98d7e4e6badfc7a128dfe91710",
      "ec0c6b3d0c6b1d629a6c1e41844ce0c75b9445833d848aa6321cd1bca340b3d2",
    ]);
    expect(BUILTIN_LIDARR_PRESET_PACKS.every(({ digest }) => /^[a-f0-9]{64}$/u.test(digest))).toBe(
      true,
    );
  });

  it.each([
    {
      id: "balanced",
      profileName: "RFMedia Balanced",
      itemNames: ["High Quality Lossy", "Lossless"],
      cutoff: "Lossless",
      customFormatName: "RFMedia WEB Source",
      score: 25,
    },
    {
      id: "lossless",
      profileName: "RFMedia Lossless",
      itemNames: ["Lossless"],
      cutoff: "Lossless",
      customFormatName: "RFMedia 24-bit Lossless",
      score: 100,
    },
    {
      id: "space-saver",
      profileName: "RFMedia Space Saver",
      itemNames: ["Mid Quality Lossy", "High Quality Lossy"],
      cutoff: "High Quality Lossy",
      customFormatName: "RFMedia MP3 320",
      score: 25,
    },
  ])("ships the approved $id@1 policy", (expected) => {
    const pack = resolveLidarrPresetPack(expected.id);
    const profile = pack.qualityProfiles[0]!;

    expect(pack.version).toBe(1);
    expect(pack.customFormats).toHaveLength(1);
    expect(pack.qualityProfiles).toHaveLength(1);
    expect(profile).toMatchObject({
      name: expected.profileName,
      upgradeAllowed: true,
      cutoff: expected.cutoff,
      minFormatScore: 0,
      cutoffFormatScore: expected.score,
      formatScores: [{ customFormatName: expected.customFormatName, score: expected.score }],
    });
    expect(profile.items.map(({ name }) => name)).toEqual(expected.itemNames);
    expect(pack.naming).toEqual({
      renameTracks: true,
      replaceIllegalCharacters: true,
      colonReplacementFormat: 4,
      standardTrackFormat:
        "{Album Title} ({Release Year})/{Artist Name} - {Album Title} - {track:00} - {Track Title}",
      multiDiscTrackFormat:
        "{Album Title} ({Release Year})/{Medium Format} {medium:00}/{Artist Name} - {Album Title} - {track:00} - {Track Title}",
      artistFolderFormat: "{Artist Name}",
    });
    expect(() => validateLidarrPresetPack(pack)).not.toThrow();
    expect(() => assertLidarrPresetCompatible(pack, makeEmptyState())).not.toThrow();
  });

  it("resolves qualified references and rejects ambiguous unqualified references", () => {
    const balanced = resolveLidarrPresetPack("builtin:balanced");
    const configured = { balanced: asConfiguredPack(balanced) };

    expect(resolveLidarrPresetPack("config:balanced", configured).source).toBe("config");
    expect(resolveLidarrPresetPack("builtin:balanced", configured)).toBe(balanced);
    expect(() => resolveLidarrPresetPack("balanced", configured)).toThrow("ambiguous");
    expect(() => resolveLidarrPresetPack("missing", configured)).toThrow("not found");
  });

  it("rejects unsupported live schemas and ambiguous portable names", () => {
    const pack = resolveLidarrPresetPack("lossless");
    const missingFieldState: LidarrPresetLiveState = {
      ...makeEmptyState(),
      customFormatSchema: makeEmptyState().customFormatSchema.map((schema) =>
        schema.implementation === "ReleaseTitleSpecification" ? { ...schema, fields: [] } : schema,
      ),
    };
    expect(() => assertLidarrPresetCompatible(pack, missingFieldState)).toThrow(
      "ReleaseTitleSpecification.value",
    );

    const duplicateQualityState: LidarrPresetLiveState = {
      ...makeEmptyState(),
      qualityProfileSchema: {
        ...makeEmptyState().qualityProfileSchema,
        items: [
          ...makeEmptyState().qualityProfileSchema.items,
          {
            kind: "quality",
            id: 999,
            quality: { id: 999, name: "FLAC" },
            allowed: false,
          },
        ],
      },
    };
    expect(() => assertLidarrPresetCompatible(pack, duplicateQualityState)).toThrow("ambiguous");
  });

  it("rejects reordered or reparented live qualities before building a profile", () => {
    const pack = resolveLidarrPresetPack("lossless");
    const schema = makeEmptyState().qualityProfileSchema;
    const highQualityLossy = schema.items[1]!;
    const lossless = schema.items[2]!;
    if (highQualityLossy.kind !== "group" || lossless.kind !== "group") {
      throw new Error("expected supported quality groups");
    }
    const movedQuality = lossless.items[0]!;
    const incompatibleSchemas = [
      {
        ...schema,
        items: schema.items.map((item) =>
          item.id === lossless.id
            ? {
                ...lossless,
                items: [lossless.items[1]!, lossless.items[0]!, ...lossless.items.slice(2)],
              }
            : item,
        ),
      },
      {
        ...schema,
        items: schema.items.map((item) => {
          if (item.id === highQualityLossy.id) {
            return { ...highQualityLossy, items: [...highQualityLossy.items, movedQuality] };
          }
          return item.id === lossless.id ? { ...lossless, items: lossless.items.slice(1) } : item;
        }),
      },
    ];

    for (const incompatibleSchema of incompatibleSchemas) {
      const state = { ...makeEmptyState(), qualityProfileSchema: incompatibleSchema };
      expect(() => assertLidarrPresetCompatible(pack, state)).toThrow(
        "live quality hierarchy is incompatible",
      );
      expect(() =>
        buildLidarrPresetQualityProfileInput(
          pack.qualityProfiles[0]!,
          incompatibleSchema,
          undefined,
        ),
      ).toThrow("live quality hierarchy is incompatible");
    }
  });

  it("preserves unmanaged format scores while overlaying managed scores", () => {
    const pack = resolveLidarrPresetPack("balanced");
    const managed = makeCustomFormatDefinition(pack, 501);
    const schema = withFormatItems(makeEmptyState(), [
      { customFormat: { id: managed.id, name: managed.name }, score: 0 },
      { customFormat: { id: 777, name: "User Seedbox" }, score: 0 },
    ]).qualityProfileSchema;
    const current: LidarrPresetQualityProfileDefinition = {
      ...buildLidarrPresetQualityProfileInput(pack.qualityProfiles[0]!, schema, undefined),
      id: 601,
      formatItems: [
        { customFormat: { id: managed.id, name: managed.name }, score: 5 },
        { customFormat: { id: 777, name: "User Seedbox" }, score: 73 },
      ],
    };

    expect(
      buildLidarrPresetQualityProfileInput(pack.qualityProfiles[0]!, schema, current).formatItems,
    ).toEqual([
      { customFormat: { id: managed.id, name: managed.name }, score: 25 },
      { customFormat: { id: 777, name: "User Seedbox" }, score: 73 },
    ]);
    expect(current.formatItems[1]?.score).toBe(73);
  });

  it("classifies create, update, unchanged, and retained resources deterministically", () => {
    const pack = resolveLidarrPresetPack("space-saver");
    const createDiff = createLidarrPresetDiff(pack, makeEmptyState());
    expect(createDiff.map(({ action }) => action)).toEqual(["create", "create", "update"]);

    const converged = makeConvergedState(pack);
    expect(createLidarrPresetDiff(pack, converged).map(({ action }) => action)).toEqual([
      "unchanged",
      "unchanged",
      "unchanged",
    ]);

    const changed: LidarrPresetLiveState = {
      ...converged,
      customFormats: [
        { ...converged.customFormats[0]!, includeCustomFormatWhenRenaming: true },
        {
          id: 888,
          name: "User Format",
          includeCustomFormatWhenRenaming: false,
          specifications: [
            {
              id: 8_881,
              name: "User marker",
              implementation: "ReleaseTitleSpecification",
              negate: false,
              required: true,
              fields: { value: "USER" },
            },
          ],
        },
      ],
      qualityProfiles: [
        converged.qualityProfiles[0]!,
        { ...converged.qualityProfiles[0]!, id: 889, name: "User Profile" },
      ],
      naming: { ...converged.naming, renameTracks: false },
    };
    expect(createLidarrPresetDiff(pack, changed).map(({ action }) => action)).toEqual([
      "update",
      "unchanged",
      "update",
      "retained",
      "retained",
    ]);
  });

  it("rejects unsafe regex and naming templates locally", () => {
    const pack = resolveLidarrPresetPack("balanced");
    const format = pack.customFormats[0]!;
    const specification = format.specifications[0]!;
    const unsafeRegex: LidarrPresetPack = {
      ...pack,
      customFormats: [
        {
          ...format,
          specifications: [{ ...specification, fields: { value: "(WEB+)+" } }],
        },
      ],
    };
    expect(() => validateLidarrPresetPack(unsafeRegex)).toThrow("unsafe regular expression");

    const unsafeNaming: LidarrPresetPack = {
      ...pack,
      naming: { ...pack.naming, artistFolderFormat: "../{Artist Name}" },
    };
    expect(() => validateLidarrPresetPack(unsafeNaming)).toThrow("unsafe naming template");
  });

  it("does not mutate inputs and converges on the second semantic run", () => {
    const pack = resolveLidarrPresetPack("balanced");
    const state = makeConvergedState(pack);
    const before = structuredClone(state);

    const first = createLidarrPresetDiff(pack, state);
    const second = createLidarrPresetDiff(pack, state);

    expect(first).toEqual(second);
    expect(first.every(({ action }) => action === "unchanged")).toBe(true);
    expect(state).toEqual(before);
  });
});
