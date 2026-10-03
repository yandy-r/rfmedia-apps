import { createHash } from "node:crypto";

import type { LidarrConfiguredPresetPack } from "../../types/config.js";
import type {
  LidarrPresetCapability,
  LidarrPresetCustomFormat,
  LidarrPresetCustomFormatDefinition,
  LidarrPresetCustomFormatImplementation,
  LidarrPresetCustomFormatSpecification,
  LidarrPresetCustomFormatSpecificationSchema,
  LidarrPresetFieldValue,
  LidarrPresetLiveFormatScore,
  LidarrPresetLiveQualityItem,
  LidarrPresetNaming,
  LidarrPresetNamingConfig,
  LidarrPresetPack,
  LidarrPresetQualityItem,
  LidarrPresetQualityProfile,
  LidarrPresetQualityProfileCreateInput,
  LidarrPresetQualityProfileDefinition,
  LidarrPresetQualityProfileSchema,
  LidarrPresetResourceDiff,
  LidarrPresetSemanticFieldChange,
  LidarrPresetSemanticValue,
} from "../../types/lidarr-presets.js";

const NORMALIZED_NAME_LOCALE = "en-US";
const MAX_PRESET_STRING_BYTES = 2_048;
const MIN_FORMAT_SCORE = -10_000;
const MAX_FORMAT_SCORE = 10_000;
const TERMINAL_CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const SAFE_PACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const SAFE_NAMING_TOKENS = new Set([
  "album title",
  "artist name",
  "medium format",
  "medium",
  "original filename",
  "original title",
  "release year",
  "track",
  "track title",
]);

const ALL_CAPABILITIES = [
  "custom-format-schema",
  "custom-format-create",
  "custom-format-update",
  "quality-profile-schema",
  "quality-profile-create",
  "quality-profile-update",
  "naming-read",
  "naming-examples",
  "naming-update",
] as const satisfies readonly LidarrPresetCapability[];

const IMPLEMENTATION_FIELDS = {
  ReleaseTitleSpecification: ["value"],
  ReleaseGroupSpecification: ["value"],
  IndexerFlagSpecification: ["value"],
  SizeSpecification: ["min", "max"],
} as const satisfies Record<LidarrPresetCustomFormatImplementation, readonly string[]>;

const OFFICIAL_STANDARD_TRACK_FORMAT =
  "{Album Title} ({Release Year})/{Artist Name} - {Album Title} - {track:00} - {Track Title}";
const OFFICIAL_MULTI_DISC_TRACK_FORMAT =
  "{Album Title} ({Release Year})/{Medium Format} {medium:00}/{Artist Name} - {Album Title} - {track:00} - {Track Title}";
const OFFICIAL_ARTIST_FOLDER_FORMAT = "{Artist Name}";

const MID_QUALITY_LOSSY = [
  ["OGG Vorbis Q7", 17],
  ["MP3-VBR-V2", 8],
  ["MP3-256", 3],
  ["OGG Vorbis Q8", 16],
  ["AAC-256", 10],
] as const;
const HIGH_QUALITY_LOSSY = [
  ["MP3-VBR-V0", 2],
  ["AAC-VBR", 12],
  ["MP3-320", 4],
  ["OGG Vorbis Q9", 15],
  ["AAC-320", 11],
  ["OGG Vorbis Q10", 14],
] as const;
const LOSSLESS = [
  ["FLAC", 6],
  ["ALAC", 7],
  ["APE", 35],
  ["WavPack", 36],
  ["FLAC 24bit", 21],
  ["ALAC 24bit", 37],
] as const;

export class LidarrPresetValidationError extends Error {
  override readonly name = "LidarrPresetValidationError";

  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`${path}: ${detail}`);
  }
}

export interface LidarrPresetSupportedFixture {
  readonly evidence: {
    readonly openApiUpstreamCommit: string;
    readonly qualitySource: string;
    readonly namingSource: string;
  };
  readonly capabilities: readonly LidarrPresetCapability[];
  readonly customFormatSchema: readonly LidarrPresetCustomFormatSpecificationSchema[];
  readonly qualityProfileSchema: LidarrPresetQualityProfileSchema;
  readonly naming: LidarrPresetNamingConfig;
}

export interface LidarrPresetLiveState {
  readonly capabilities: readonly LidarrPresetCapability[];
  readonly customFormatSchema: readonly LidarrPresetCustomFormatSpecificationSchema[];
  readonly customFormats: readonly LidarrPresetCustomFormatDefinition[];
  readonly qualityProfileSchema: LidarrPresetQualityProfileSchema;
  readonly qualityProfiles: readonly LidarrPresetQualityProfileDefinition[];
  readonly naming: LidarrPresetNamingConfig;
}

export interface LidarrPresetDiffImpact {
  readonly referencingProfilesByCustomFormat?: Readonly<Record<string, readonly string[]>>;
  readonly assignedArtistCountByQualityProfile?: Readonly<Record<string, number>>;
}

function normalizeName(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase(NORMALIZED_NAME_LOCALE);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function digestPack(value: Omit<LidarrPresetPack, "digest">): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function requireSafeString(value: string, path: string): void {
  if (
    value.trim() === "" ||
    Buffer.byteLength(value, "utf8") > MAX_PRESET_STRING_BYTES ||
    TERMINAL_CONTROL_PATTERN.test(value)
  ) {
    throw new LidarrPresetValidationError(path, "must be a bounded terminal-safe string");
  }
}

function assertUniqueNames(values: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    const normalized = normalizeName(value);
    if (seen.has(normalized)) {
      throw new LidarrPresetValidationError(`${path}[${index}]`, "duplicate normalized name");
    }
    seen.add(normalized);
  }
}

function assertSafeRegex(value: string, path: string): void {
  requireSafeString(value, path);
  if (
    /\\(?:[1-9]|k<)/u.test(value) ||
    /\(\?<[=!]/u.test(value) ||
    /\([^)]*[+*][^)]*\)(?:[+*]|\{\d)/u.test(value)
  ) {
    throw new LidarrPresetValidationError(path, "unsafe regular expression");
  }
  try {
    new RegExp(value, "iu");
  } catch {
    throw new LidarrPresetValidationError(path, "invalid regular expression");
  }
}

function assertExactFieldNames(
  fields: Readonly<Record<string, LidarrPresetFieldValue>>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(fields).sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    throw new LidarrPresetValidationError(
      path,
      `expected fields ${sortedExpected.join(", ")}, received ${actual.join(", ")}`,
    );
  }
}

function validateSpecification(
  specification: LidarrPresetCustomFormatSpecification,
  path: string,
): void {
  requireSafeString(specification.name, `${path}.name`);
  const expectedFields = IMPLEMENTATION_FIELDS[specification.implementation];
  if (!expectedFields) {
    throw new LidarrPresetValidationError(
      `${path}.implementation`,
      `unsupported implementation ${specification.implementation}`,
    );
  }
  assertExactFieldNames(specification.fields, expectedFields, `${path}.fields`);
  if (
    specification.implementation === "ReleaseTitleSpecification" ||
    specification.implementation === "ReleaseGroupSpecification"
  ) {
    const value = specification.fields["value"];
    if (typeof value !== "string") {
      throw new LidarrPresetValidationError(`${path}.fields.value`, "must be a string");
    }
    assertSafeRegex(value, `${path}.fields.value`);
    return;
  }
  if (specification.implementation === "IndexerFlagSpecification") {
    const value = specification.fields["value"];
    if (!Number.isSafeInteger(value) || typeof value !== "number" || value <= 0) {
      throw new LidarrPresetValidationError(`${path}.fields.value`, "must be a positive integer");
    }
    return;
  }
  const min = specification.fields["min"];
  const max = specification.fields["max"];
  if (
    typeof min !== "number" ||
    typeof max !== "number" ||
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    min < 0 ||
    max <= min
  ) {
    throw new LidarrPresetValidationError(
      `${path}.fields`,
      "SizeSpecification requires finite min >= 0 and max > min",
    );
  }
}

function collectQualityItemNames(
  items: readonly LidarrPresetQualityItem[],
  path: string,
  output: { readonly name: string; readonly path: string }[],
): void {
  for (const [index, item] of items.entries()) {
    const itemPath = `${path}[${index}]`;
    requireSafeString(item.name, `${itemPath}.name`);
    output.push({ name: item.name, path: `${itemPath}.name` });
    if (item.kind === "group") {
      if (item.items.length === 0) {
        throw new LidarrPresetValidationError(`${itemPath}.items`, "must not be empty");
      }
      collectQualityItemNames(item.items, `${itemPath}.items`, output);
    }
  }
}

function validateNaming(naming: LidarrPresetNaming, path: string): void {
  if (
    !Number.isSafeInteger(naming.colonReplacementFormat) ||
    naming.colonReplacementFormat < 0 ||
    naming.colonReplacementFormat > 4
  ) {
    throw new LidarrPresetValidationError(
      `${path}.colonReplacementFormat`,
      "must be an integer from 0 through 4",
    );
  }
  const templates = [
    ["standardTrackFormat", naming.standardTrackFormat],
    ["multiDiscTrackFormat", naming.multiDiscTrackFormat],
    ["artistFolderFormat", naming.artistFolderFormat],
  ] as const;
  for (const [field, template] of templates) {
    const fieldPath = `${path}.${field}`;
    requireSafeString(template, fieldPath);
    const withoutTokens = template.replace(/\{([^{}]+)\}/gu, (_match, rawToken: string) => {
      const normalizedToken = normalizeName(rawToken.split(":", 1)[0] ?? "");
      if (!SAFE_NAMING_TOKENS.has(normalizedToken)) {
        throw new LidarrPresetValidationError(fieldPath, `unsupported naming token ${rawToken}`);
      }
      return "";
    });
    if (
      withoutTokens.includes("{") ||
      withoutTokens.includes("}") ||
      /^(?:[\\/]|[a-z]:[\\/])/iu.test(template) ||
      /(?:^|[\\/])\.{1,2}(?:[\\/]|$)/u.test(template)
    ) {
      throw new LidarrPresetValidationError(fieldPath, "unsafe naming template");
    }
  }
  const hasRequiredTrackTokens = (template: string): boolean =>
    (/\{track title\}/iu.test(template) && /\{track(?::0+)?\}/iu.test(template)) ||
    /\{original (?:title|filename)\}/iu.test(template);
  if (!hasRequiredTrackTokens(naming.standardTrackFormat)) {
    throw new LidarrPresetValidationError(
      `${path}.standardTrackFormat`,
      "requires track title plus track number, original title, or original filename",
    );
  }
  if (!hasRequiredTrackTokens(naming.multiDiscTrackFormat)) {
    throw new LidarrPresetValidationError(
      `${path}.multiDiscTrackFormat`,
      "requires track title plus track number, original title, or original filename",
    );
  }
  if (!/\{artist name\}/iu.test(naming.artistFolderFormat)) {
    throw new LidarrPresetValidationError(
      `${path}.artistFolderFormat`,
      "requires the Artist Name token",
    );
  }
}

export function validateLidarrPresetPack(pack: LidarrPresetPack): void {
  if (!SAFE_PACK_ID_PATTERN.test(pack.id)) {
    throw new LidarrPresetValidationError("pack.id", "must be a lowercase kebab-case ID");
  }
  if (pack.ref !== `${pack.source}:${pack.id}`) {
    throw new LidarrPresetValidationError("pack.ref", "must match source and ID");
  }
  if (!Number.isSafeInteger(pack.version) || pack.version <= 0) {
    throw new LidarrPresetValidationError("pack.version", "must be a positive integer");
  }
  for (const [field, values] of [
    ["assumptions", pack.assumptions],
    ["consequences", pack.consequences],
  ] as const) {
    if (values.length === 0) {
      throw new LidarrPresetValidationError(`pack.${field}`, "must not be empty");
    }
    values.forEach((value, index) => requireSafeString(value, `pack.${field}[${index}]`));
  }
  requireSafeString(pack.description, "pack.description");
  requireSafeString(pack.provenance, "pack.provenance");
  if (pack.customFormats.length === 0 || pack.qualityProfiles.length === 0) {
    throw new LidarrPresetValidationError(
      "pack",
      "must contain at least one custom format and quality profile",
    );
  }
  assertUniqueNames(
    pack.customFormats.map(({ name }) => name),
    "pack.customFormats",
  );
  assertUniqueNames(
    pack.qualityProfiles.map(({ name }) => name),
    "pack.qualityProfiles",
  );
  assertUniqueNames(pack.capabilities, "pack.capabilities");
  for (const [index, capability] of pack.capabilities.entries()) {
    if (!ALL_CAPABILITIES.includes(capability)) {
      throw new LidarrPresetValidationError(
        `pack.capabilities[${index}]`,
        `unsupported capability ${capability}`,
      );
    }
  }
  const customFormatNames = new Set(pack.customFormats.map(({ name }) => normalizeName(name)));
  for (const [formatIndex, format] of pack.customFormats.entries()) {
    const formatPath = `pack.customFormats[${formatIndex}]`;
    requireSafeString(format.name, `${formatPath}.name`);
    if (format.specifications.length === 0) {
      throw new LidarrPresetValidationError(`${formatPath}.specifications`, "must not be empty");
    }
    assertUniqueNames(
      format.specifications.map(({ name }) => name),
      `${formatPath}.specifications`,
    );
    format.specifications.forEach((specification, index) =>
      validateSpecification(specification, `${formatPath}.specifications[${index}]`),
    );
  }
  for (const [profileIndex, profile] of pack.qualityProfiles.entries()) {
    const profilePath = `pack.qualityProfiles[${profileIndex}]`;
    requireSafeString(profile.name, `${profilePath}.name`);
    if (profile.items.length === 0) {
      throw new LidarrPresetValidationError(`${profilePath}.items`, "must not be empty");
    }
    const names: { readonly name: string; readonly path: string }[] = [];
    collectQualityItemNames(profile.items, `${profilePath}.items`, names);
    const normalizedNames = new Set<string>();
    for (const entry of names) {
      const normalized = normalizeName(entry.name);
      if (normalizedNames.has(normalized)) {
        throw new LidarrPresetValidationError(entry.path, "duplicate normalized name");
      }
      normalizedNames.add(normalized);
    }
    if (!normalizedNames.has(normalizeName(profile.cutoff))) {
      throw new LidarrPresetValidationError(`${profilePath}.cutoff`, "unresolved cutoff");
    }
    if (
      !Number.isSafeInteger(profile.minFormatScore) ||
      !Number.isSafeInteger(profile.cutoffFormatScore) ||
      profile.minFormatScore < MIN_FORMAT_SCORE ||
      profile.cutoffFormatScore > MAX_FORMAT_SCORE ||
      profile.cutoffFormatScore < profile.minFormatScore
    ) {
      throw new LidarrPresetValidationError(
        `${profilePath}.minFormatScore`,
        "invalid score bounds",
      );
    }
    assertUniqueNames(
      profile.formatScores.map(({ customFormatName }) => customFormatName),
      `${profilePath}.formatScores`,
    );
    for (const [scoreIndex, score] of profile.formatScores.entries()) {
      const scorePath = `${profilePath}.formatScores[${scoreIndex}]`;
      if (!customFormatNames.has(normalizeName(score.customFormatName))) {
        throw new LidarrPresetValidationError(
          `${scorePath}.customFormatName`,
          "unknown custom format",
        );
      }
      if (
        !Number.isSafeInteger(score.score) ||
        score.score < MIN_FORMAT_SCORE ||
        score.score > MAX_FORMAT_SCORE
      ) {
        throw new LidarrPresetValidationError(`${scorePath}.score`, "invalid format score");
      }
    }
  }
  validateNaming(pack.naming, "pack.naming");
}

function fixtureGroup(
  id: number,
  name: string,
  qualities: readonly (readonly [string, number])[],
): LidarrPresetLiveQualityItem {
  return {
    kind: "group",
    id,
    name,
    allowed: false,
    items: qualities.map(([qualityName, qualityId]) => ({
      kind: "quality",
      id: qualityId,
      quality: { id: qualityId, name: qualityName },
      allowed: false,
    })),
  };
}

function fixtureSchema(
  implementation: LidarrPresetCustomFormatImplementation,
  fields: readonly { readonly name: string; readonly type: string }[],
): LidarrPresetCustomFormatSpecificationSchema {
  return {
    implementation,
    implementationName: implementation.replace(/Specification$/u, ""),
    fields: fields.map(({ name, type }) => ({
      name,
      label: name,
      type,
      advanced: false,
      selectOptions: [],
    })),
  };
}

export const LIDARR_PRESET_SUPPORTED_FIXTURE_V1 = deepFreeze({
  evidence: {
    openApiUpstreamCommit: "3e2858439ff35b372d0af00bcea1b0a357572d26",
    qualitySource:
      "Lidarr/Lidarr@d4c72f8ee93113ce82321b78c3365dbaf435f1b8:src/NzbDrone.Core/Qualities/Quality.cs",
    namingSource:
      "Lidarr/Lidarr@d4c72f8ee93113ce82321b78c3365dbaf435f1b8:src/NzbDrone.Core/Organizer/NamingConfig.cs",
  },
  capabilities: [...ALL_CAPABILITIES],
  customFormatSchema: [
    fixtureSchema("ReleaseTitleSpecification", [{ name: "value", type: "string" }]),
    fixtureSchema("ReleaseGroupSpecification", [{ name: "value", type: "string" }]),
    fixtureSchema("IndexerFlagSpecification", [{ name: "value", type: "integer" }]),
    fixtureSchema("SizeSpecification", [
      { name: "min", type: "number" },
      { name: "max", type: "number" },
    ]),
  ],
  qualityProfileSchema: {
    items: [
      fixtureGroup(1_004, "Mid Quality Lossy", MID_QUALITY_LOSSY),
      fixtureGroup(1_005, "High Quality Lossy", HIGH_QUALITY_LOSSY),
      fixtureGroup(1_006, "Lossless", LOSSLESS),
    ],
    formatItems: [],
  },
  naming: {
    id: 1,
    renameTracks: false,
    replaceIllegalCharacters: true,
    colonReplacementFormat: 4,
    standardTrackFormat: OFFICIAL_STANDARD_TRACK_FORMAT,
    multiDiscTrackFormat: OFFICIAL_MULTI_DISC_TRACK_FORMAT,
    artistFolderFormat: OFFICIAL_ARTIST_FOLDER_FORMAT,
  },
} satisfies LidarrPresetSupportedFixture);

function desiredGroup(
  name: string,
  qualities: readonly (readonly [string, number])[],
): LidarrPresetQualityItem {
  return {
    kind: "group",
    name,
    allowed: true,
    items: qualities.map(([qualityName]) => ({
      kind: "quality",
      name: qualityName,
      allowed: true,
    })),
  };
}

function activeOfficialNaming(): LidarrPresetNaming {
  return {
    renameTracks: true,
    replaceIllegalCharacters: true,
    colonReplacementFormat: 4,
    standardTrackFormat: OFFICIAL_STANDARD_TRACK_FORMAT,
    multiDiscTrackFormat: OFFICIAL_MULTI_DISC_TRACK_FORMAT,
    artistFolderFormat: OFFICIAL_ARTIST_FOLDER_FORMAT,
  };
}

interface BuiltinPackContent {
  readonly id: string;
  readonly description: string;
  readonly assumptions: readonly string[];
  readonly consequences: readonly string[];
  readonly customFormat: LidarrPresetCustomFormat;
  readonly qualityProfile: LidarrPresetQualityProfile;
}

function makeBuiltinPack(content: BuiltinPackContent): LidarrPresetPack {
  const withoutDigest: Omit<LidarrPresetPack, "digest"> = {
    source: "builtin",
    ref: `builtin:${content.id}`,
    id: content.id,
    version: 1,
    provenance:
      "rfmedia built-in policy backed by LIDARR_PRESET_SUPPORTED_FIXTURE_V1 and approved for issue #213",
    description: content.description,
    assumptions: content.assumptions,
    consequences: content.consequences,
    capabilities: [...ALL_CAPABILITIES],
    customFormats: [content.customFormat],
    qualityProfiles: [content.qualityProfile],
    naming: activeOfficialNaming(),
  };
  const pack = { ...withoutDigest, digest: digestPack(withoutDigest) };
  validateLidarrPresetPack(pack);
  return deepFreeze(pack);
}

function releaseTitleFormat(
  name: string,
  specificationName: string,
  value: string,
): LidarrPresetCustomFormat {
  return {
    name,
    includeCustomFormatWhenRenaming: false,
    specifications: [
      {
        name: specificationName,
        implementation: "ReleaseTitleSpecification",
        negate: false,
        required: true,
        fields: { value },
      },
    ],
  };
}

export const BUILTIN_LIDARR_PRESET_PACKS = deepFreeze([
  makeBuiltinPack({
    id: "balanced",
    description:
      "Accept high-quality lossy releases while upgrading toward lossless, with a WEB-source preference.",
    assumptions: [
      "The connected schema exposes the High Quality Lossy and Lossless groups with the approved ordered qualities.",
      "Release titles identify WEB or WEB-DL sources when that preference is meaningful.",
      "The operator accepts lossless storage growth in exchange for quality upgrades.",
    ],
    consequences: [
      "High-quality lossy and lossless codecs are accepted, and upgrades continue until the Lossless cutoff and WEB score are satisfied.",
      "WEB is a title-based preference rather than proof of provenance.",
      "Track naming is enabled for future imports and explicit Lidarr rename operations; existing files are never renamed by applying the pack.",
      "Unmanaged custom formats, profiles, and format scores are retained.",
    ],
    customFormat: releaseTitleFormat("RFMedia WEB Source", "WEB source", "\\bWEB(?:[-_. ]?DL)?\\b"),
    qualityProfile: {
      name: "RFMedia Balanced",
      upgradeAllowed: true,
      cutoff: "Lossless",
      items: [
        desiredGroup("High Quality Lossy", HIGH_QUALITY_LOSSY),
        desiredGroup("Lossless", LOSSLESS),
      ],
      minFormatScore: 0,
      cutoffFormatScore: 25,
      formatScores: [{ customFormatName: "RFMedia WEB Source", score: 25 }],
    },
  }),
  makeBuiltinPack({
    id: "lossless",
    description:
      "Require the supported lossless group and prefer releases whose titles carry a 24-bit marker.",
    assumptions: [
      "The connected schema exposes the approved Lossless group and ordered FLAC, ALAC, APE, WavPack, and 24-bit qualities.",
      "Release titles identify 24-bit FLAC or ALAC releases when that preference is meaningful.",
      "The operator prioritizes preservation quality over storage and bandwidth.",
    ],
    consequences: [
      "No lossy fallback is accepted, and lossless releases can consume substantially more storage and bandwidth.",
      "The supported Lossless group also admits ALAC, APE, and WavPack; 24-bit is preferred rather than required.",
      "Track naming is enabled for future imports and explicit Lidarr rename operations; existing files are never renamed by applying the pack.",
      "Unmanaged custom formats, profiles, and format scores are retained.",
    ],
    customFormat: releaseTitleFormat(
      "RFMedia 24-bit Lossless",
      "24-bit marker",
      "\\b(?:FLAC|ALAC)[-_. ]?24(?:[-_. ]?bit)?\\b|\\b24[-_. ]?bit\\b",
    ),
    qualityProfile: {
      name: "RFMedia Lossless",
      upgradeAllowed: true,
      cutoff: "Lossless",
      items: [desiredGroup("Lossless", LOSSLESS)],
      minFormatScore: 0,
      cutoffFormatScore: 100,
      formatScores: [{ customFormatName: "RFMedia 24-bit Lossless", score: 100 }],
    },
  }),
  makeBuiltinPack({
    id: "space-saver",
    description:
      "Restrict acquisition to mid- and high-quality lossy groups while preferring MP3-320 titles.",
    assumptions: [
      "The connected schema exposes the Mid Quality Lossy and High Quality Lossy groups with the approved ordered qualities.",
      "Lossy audio is acceptable and release titles identify MP3-320 when present.",
      "Reduced storage and bandwidth are more important than lossless preservation.",
    ],
    consequences: [
      "Lossless releases are excluded, materially reducing typical storage at the cost of irreversible lossy compression.",
      "AAC, OGG Vorbis, and MP3 codecs remain eligible; MP3-320 is a preference rather than a hard gate.",
      "Track naming is enabled for future imports and explicit Lidarr rename operations; existing files are never renamed by applying the pack.",
      "Unmanaged custom formats, profiles, and format scores are retained.",
    ],
    customFormat: releaseTitleFormat(
      "RFMedia MP3 320",
      "MP3 320 marker",
      "\\bMP3[-_. ]?320\\b|\\b320(?:kbps|k)\\b",
    ),
    qualityProfile: {
      name: "RFMedia Space Saver",
      upgradeAllowed: true,
      cutoff: "High Quality Lossy",
      items: [
        desiredGroup("Mid Quality Lossy", MID_QUALITY_LOSSY),
        desiredGroup("High Quality Lossy", HIGH_QUALITY_LOSSY),
      ],
      minFormatScore: 0,
      cutoffFormatScore: 25,
      formatScores: [{ customFormatName: "RFMedia MP3 320", score: 25 }],
    },
  }),
] as const satisfies readonly LidarrPresetPack[]);

function configuredPack(id: string, configured: LidarrConfiguredPresetPack): LidarrPresetPack {
  if (!SAFE_PACK_ID_PATTERN.test(id)) {
    throw new LidarrPresetValidationError("pack.id", "must be a lowercase kebab-case ID");
  }
  const withoutDigest: Omit<LidarrPresetPack, "digest"> = {
    source: "config",
    ref: `config:${id}`,
    id,
    version: configured.version,
    provenance: `lidarr.profilePresets.packs.${id}`,
    description: configured.description,
    assumptions: clone(configured.assumptions),
    consequences: clone(configured.consequences),
    capabilities: clone(configured.capabilities),
    customFormats: clone(configured.customFormats),
    qualityProfiles: clone(configured.qualityProfiles),
    naming: clone(configured.naming),
  };
  const pack = { ...withoutDigest, digest: digestPack(withoutDigest) };
  validateLidarrPresetPack(pack);
  return deepFreeze(pack);
}

export function resolveLidarrPresetPack(
  reference: string,
  configuredPacks: Readonly<Record<string, LidarrConfiguredPresetPack>> = {},
): LidarrPresetPack {
  requireSafeString(reference, "packRef");
  const separatorIndex = reference.indexOf(":");
  const explicitSource =
    separatorIndex === -1 ? undefined : reference.slice(0, separatorIndex).toLocaleLowerCase();
  const requestedId = separatorIndex === -1 ? reference : reference.slice(separatorIndex + 1);
  const normalizedId = normalizeName(requestedId);
  if (!SAFE_PACK_ID_PATTERN.test(requestedId)) {
    throw new LidarrPresetValidationError("packRef", "contains an invalid pack ID");
  }
  if (explicitSource !== undefined && explicitSource !== "builtin" && explicitSource !== "config") {
    throw new LidarrPresetValidationError("packRef", `unsupported source ${explicitSource}`);
  }
  const builtinMatches = BUILTIN_LIDARR_PRESET_PACKS.filter(
    ({ id }) => normalizeName(id) === normalizedId,
  );
  const configMatches = Object.entries(configuredPacks)
    .filter(([id]) => normalizeName(id) === normalizedId)
    .map(([id, pack]) => configuredPack(id, pack));
  const matches =
    explicitSource === "builtin"
      ? builtinMatches
      : explicitSource === "config"
        ? configMatches
        : [...builtinMatches, ...configMatches];
  if (matches.length === 0) {
    throw new LidarrPresetValidationError("packRef", `preset ${reference} not found`);
  }
  if (matches.length > 1) {
    throw new LidarrPresetValidationError(
      "packRef",
      `preset ${reference} is ambiguous; use builtin: or config:`,
    );
  }
  return matches[0]!;
}

function flattenLiveQualityItems(
  items: readonly LidarrPresetLiveQualityItem[],
  output: {
    readonly id: number;
    readonly name: string;
    readonly item: LidarrPresetLiveQualityItem;
  }[],
): void {
  for (const item of items) {
    if (item.kind === "quality") {
      output.push({ id: item.quality.id, name: item.quality.name, item });
    } else {
      output.push({ id: item.id, name: item.name, item });
      flattenLiveQualityItems(item.items, output);
    }
  }
}

function resolveUniqueLiveQuality(
  name: string,
  items: readonly LidarrPresetLiveQualityItem[],
  path: string,
): { readonly id: number; readonly name: string; readonly item: LidarrPresetLiveQualityItem } {
  const flattened: {
    readonly id: number;
    readonly name: string;
    readonly item: LidarrPresetLiveQualityItem;
  }[] = [];
  flattenLiveQualityItems(items, flattened);
  const normalized = normalizeName(name);
  const matches = flattened.filter((entry) => normalizeName(entry.name) === normalized);
  if (matches.length === 0) {
    throw new LidarrPresetValidationError(path, `quality or group ${name} is unavailable`);
  }
  if (matches.length > 1) {
    throw new LidarrPresetValidationError(path, `quality or group ${name} is ambiguous`);
  }
  return matches[0]!;
}

function liveQualityItemName(item: LidarrPresetLiveQualityItem): string {
  return item.kind === "quality" ? item.quality.name : item.name;
}

function assertQualityItemLayout(
  configuredItems: readonly LidarrPresetQualityItem[],
  liveItems: readonly LidarrPresetLiveQualityItem[],
  path: string,
  exact = false,
): void {
  if (exact && configuredItems.length !== liveItems.length) {
    throw new LidarrPresetValidationError(path, "live quality hierarchy is incompatible");
  }
  let previousLiveIndex = -1;
  for (const [configuredIndex, configuredItem] of configuredItems.entries()) {
    const itemPath = `${path}[${configuredIndex}]`;
    const normalizedName = normalizeName(configuredItem.name);
    const matches = liveItems
      .map((item, liveIndex) => ({ item, liveIndex }))
      .filter(({ item }) => normalizeName(liveQualityItemName(item)) === normalizedName);
    if (matches.length !== 1) {
      throw new LidarrPresetValidationError(itemPath, "live quality hierarchy is incompatible");
    }
    const match = matches[0]!;
    if (match.liveIndex <= previousLiveIndex || match.item.kind !== configuredItem.kind) {
      throw new LidarrPresetValidationError(itemPath, "live quality hierarchy is incompatible");
    }
    previousLiveIndex = match.liveIndex;
    if (configuredItem.kind === "group" && match.item.kind === "group") {
      assertQualityItemLayout(configuredItem.items, match.item.items, `${itemPath}.items`, true);
    }
  }
}

function validateSchemaForSpecification(
  specification: LidarrPresetCustomFormatSpecification,
  schemas: readonly LidarrPresetCustomFormatSpecificationSchema[],
  path: string,
): void {
  const matches = schemas.filter(
    ({ implementation }) => implementation === specification.implementation,
  );
  if (matches.length !== 1) {
    throw new LidarrPresetValidationError(
      `${path}.implementation`,
      `${specification.implementation} must resolve exactly once`,
    );
  }
  const liveFieldNames = matches[0]!.fields.map(({ name }) => name).sort();
  const expectedFieldNames = [...IMPLEMENTATION_FIELDS[specification.implementation]].sort();
  if (JSON.stringify(liveFieldNames) !== JSON.stringify(expectedFieldNames)) {
    const missing = expectedFieldNames.find((name) => !liveFieldNames.includes(name));
    throw new LidarrPresetValidationError(
      `${path}.${specification.implementation}.${missing ?? "fields"}`,
      "live custom-format schema is incompatible",
    );
  }
}

export function assertLidarrPresetCompatible(
  pack: LidarrPresetPack,
  state: LidarrPresetLiveState,
): void {
  validateLidarrPresetPack(pack);
  const availableCapabilities = new Set(state.capabilities);
  for (const capability of pack.capabilities) {
    if (!availableCapabilities.has(capability)) {
      throw new LidarrPresetValidationError(
        "capabilities",
        `required capability ${capability} is unavailable`,
      );
    }
  }
  for (const [formatIndex, format] of pack.customFormats.entries()) {
    for (const [specificationIndex, specification] of format.specifications.entries()) {
      validateSchemaForSpecification(
        specification,
        state.customFormatSchema,
        `customFormats[${formatIndex}].specifications[${specificationIndex}]`,
      );
    }
  }
  for (const [profileIndex, profile] of pack.qualityProfiles.entries()) {
    const names: { readonly name: string; readonly path: string }[] = [];
    collectQualityItemNames(profile.items, `qualityProfiles[${profileIndex}].items`, names);
    for (const entry of names) {
      resolveUniqueLiveQuality(entry.name, state.qualityProfileSchema.items, entry.path);
    }
    assertQualityItemLayout(
      profile.items,
      state.qualityProfileSchema.items,
      `qualityProfiles[${profileIndex}].items`,
    );
    resolveUniqueLiveQuality(
      profile.cutoff,
      state.qualityProfileSchema.items,
      `qualityProfiles[${profileIndex}].cutoff`,
    );
  }
  validateNaming(pack.naming, "naming");
}

function desiredAllowedByName(
  items: readonly LidarrPresetQualityItem[],
  output = new Map<string, boolean>(),
): ReadonlyMap<string, boolean> {
  for (const item of items) {
    output.set(normalizeName(item.name), item.allowed);
    if (item.kind === "group") desiredAllowedByName(item.items, output);
  }
  return output;
}

function overlayQualityItems(
  items: readonly LidarrPresetLiveQualityItem[],
  desired: ReadonlyMap<string, boolean>,
): readonly LidarrPresetLiveQualityItem[] {
  return items.map((item) => {
    if (item.kind === "quality") {
      return {
        ...clone(item),
        allowed: desired.get(normalizeName(item.quality.name)) ?? false,
      };
    }
    return {
      ...clone(item),
      allowed: desired.get(normalizeName(item.name)) ?? false,
      items: overlayQualityItems(item.items, desired),
    };
  });
}

function currentScoreFor(
  item: LidarrPresetLiveFormatScore,
  current: LidarrPresetQualityProfileDefinition | undefined,
): number | undefined {
  if (!current) return undefined;
  const byId = current.formatItems.find(
    ({ customFormat }) => customFormat.id === item.customFormat.id,
  );
  if (byId) return byId.score;
  return current.formatItems.find(
    ({ customFormat }) =>
      normalizeName(customFormat.name) === normalizeName(item.customFormat.name),
  )?.score;
}

export function buildLidarrPresetQualityProfileInput(
  profile: LidarrPresetQualityProfile,
  schema: LidarrPresetQualityProfileSchema,
  current: LidarrPresetQualityProfileDefinition | undefined,
): LidarrPresetQualityProfileCreateInput {
  const names: { readonly name: string; readonly path: string }[] = [];
  collectQualityItemNames(profile.items, "profile.items", names);
  for (const entry of names) resolveUniqueLiveQuality(entry.name, schema.items, entry.path);
  assertQualityItemLayout(profile.items, schema.items, "profile.items");
  const cutoff = resolveUniqueLiveQuality(profile.cutoff, schema.items, "profile.cutoff");
  const managedScores = new Map(
    profile.formatScores.map(({ customFormatName, score }) => [
      normalizeName(customFormatName),
      score,
    ]),
  );
  for (const { customFormatName } of profile.formatScores) {
    const matches = schema.formatItems.filter(
      ({ customFormat }) => normalizeName(customFormat.name) === normalizeName(customFormatName),
    );
    if (matches.length !== 1) {
      throw new LidarrPresetValidationError(
        "profile.formatScores",
        `custom format ${customFormatName} must resolve exactly once`,
      );
    }
  }
  return {
    name: profile.name,
    upgradeAllowed: profile.upgradeAllowed,
    cutoff: cutoff.id,
    items: overlayQualityItems(schema.items, desiredAllowedByName(profile.items)),
    minFormatScore: profile.minFormatScore,
    cutoffFormatScore: profile.cutoffFormatScore,
    formatItems: schema.formatItems.map((item) => ({
      customFormat: clone(item.customFormat),
      score:
        managedScores.get(normalizeName(item.customFormat.name)) ??
        currentScoreFor(item, current) ??
        item.score,
    })),
  };
}

function customFormatSemantic(
  value: LidarrPresetCustomFormat | LidarrPresetCustomFormatDefinition,
): LidarrPresetSemanticValue {
  return {
    name: value.name,
    includeCustomFormatWhenRenaming: value.includeCustomFormatWhenRenaming,
    specifications: value.specifications.map((specification) => ({
      name: specification.name,
      implementation: specification.implementation,
      negate: specification.negate,
      required: specification.required,
      fields: Object.fromEntries(
        Object.entries(specification.fields).sort(([left], [right]) => left.localeCompare(right)),
      ),
    })),
  };
}

function flattenAllowedNames(
  items: readonly LidarrPresetLiveQualityItem[],
  output: string[] = [],
): readonly string[] {
  for (const item of items) {
    const name = item.kind === "quality" ? item.quality.name : item.name;
    if (item.allowed) output.push(name);
    if (item.kind === "group") flattenAllowedNames(item.items, output);
  }
  return output;
}

function flattenDesiredAllowedNames(
  items: readonly LidarrPresetQualityItem[],
  output: string[] = [],
): readonly string[] {
  for (const item of items) {
    if (item.allowed) output.push(item.name);
    if (item.kind === "group") flattenDesiredAllowedNames(item.items, output);
  }
  return output;
}

function liveCutoffName(profile: LidarrPresetQualityProfileDefinition): string {
  const flattened: {
    readonly id: number;
    readonly name: string;
    readonly item: LidarrPresetLiveQualityItem;
  }[] = [];
  flattenLiveQualityItems(profile.items, flattened);
  return flattened.find(({ id }) => id === profile.cutoff)?.name ?? `unresolved:${profile.cutoff}`;
}

function desiredProfileSemantic(
  profile: LidarrPresetQualityProfile,
  current: LidarrPresetQualityProfileDefinition | undefined,
): LidarrPresetSemanticValue {
  const managedNames = new Set(
    profile.formatScores.map(({ customFormatName }) => normalizeName(customFormatName)),
  );
  const retainedScores =
    current?.formatItems
      .filter(({ customFormat }) => !managedNames.has(normalizeName(customFormat.name)))
      .map(({ customFormat, score }) => ({ customFormatName: customFormat.name, score })) ?? [];
  return {
    name: profile.name,
    upgradeAllowed: profile.upgradeAllowed,
    cutoff: profile.cutoff,
    allowedItems: flattenDesiredAllowedNames(profile.items),
    minFormatScore: profile.minFormatScore,
    cutoffFormatScore: profile.cutoffFormatScore,
    formatScores: [...profile.formatScores, ...retainedScores].map(
      ({ customFormatName, score }) => ({ customFormatName, score }),
    ),
  };
}

function liveProfileSemantic(
  profile: LidarrPresetQualityProfileDefinition,
  managedProfile: LidarrPresetQualityProfile,
): LidarrPresetSemanticValue {
  const managedScoreOrder = new Map(
    managedProfile.formatScores.map(({ customFormatName }, index) => [
      normalizeName(customFormatName),
      index,
    ]),
  );
  const formatScores = profile.formatItems
    .map(({ customFormat, score }) => ({ customFormatName: customFormat.name, score }))
    .sort((left, right) => {
      const leftIndex = managedScoreOrder.get(normalizeName(left.customFormatName));
      const rightIndex = managedScoreOrder.get(normalizeName(right.customFormatName));
      if (leftIndex !== undefined || rightIndex !== undefined) {
        return (leftIndex ?? Number.MAX_SAFE_INTEGER) - (rightIndex ?? Number.MAX_SAFE_INTEGER);
      }
      return 0;
    });
  return {
    name: profile.name,
    upgradeAllowed: profile.upgradeAllowed,
    cutoff: liveCutoffName(profile),
    allowedItems: flattenAllowedNames(profile.items),
    minFormatScore: profile.minFormatScore,
    cutoffFormatScore: profile.cutoffFormatScore,
    formatScores,
  };
}

function namingSemantic(naming: LidarrPresetNaming): LidarrPresetSemanticValue {
  return {
    renameTracks: naming.renameTracks,
    replaceIllegalCharacters: naming.replaceIllegalCharacters,
    colonReplacementFormat: naming.colonReplacementFormat,
    standardTrackFormat: naming.standardTrackFormat,
    multiDiscTrackFormat: naming.multiDiscTrackFormat,
    artistFolderFormat: naming.artistFolderFormat,
  };
}

function semanticEqual(left: LidarrPresetSemanticValue, right: LidarrPresetSemanticValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function collectFieldChanges(
  before: LidarrPresetSemanticValue,
  after: LidarrPresetSemanticValue,
  path = "",
): readonly LidarrPresetSemanticFieldChange[] {
  if (semanticEqual(before, after)) return [];
  if (
    before === null ||
    after === null ||
    typeof before !== "object" ||
    typeof after !== "object" ||
    Array.isArray(before) ||
    Array.isArray(after)
  ) {
    return [{ path: path || "$", before, after }];
  }
  const beforeRecord = before as Readonly<Record<string, LidarrPresetSemanticValue>>;
  const afterRecord = after as Readonly<Record<string, LidarrPresetSemanticValue>>;
  const keys = [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])].sort();
  return keys.flatMap((key) => {
    const nextPath = path === "" ? key : `${path}.${key}`;
    return collectFieldChanges(beforeRecord[key] ?? null, afterRecord[key] ?? null, nextPath);
  });
}

function uniqueNameMatch<T extends { readonly name: string }>(
  values: readonly T[],
  name: string,
  path: string,
): T | undefined {
  const normalized = normalizeName(name);
  const matches = values.filter((value) => normalizeName(value.name) === normalized);
  if (matches.length > 1) {
    throw new LidarrPresetValidationError(path, `live resource ${name} is ambiguous`);
  }
  return matches[0];
}

function customFormatImpact(name: string, impact: LidarrPresetDiffImpact): readonly string[] {
  const normalized = normalizeName(name);
  const match = Object.entries(impact.referencingProfilesByCustomFormat ?? {}).find(
    ([key]) => normalizeName(key) === normalized,
  );
  return match ? [...match[1]] : [];
}

function assignedArtistCount(name: string, impact: LidarrPresetDiffImpact): number {
  const normalized = normalizeName(name);
  return (
    Object.entries(impact.assignedArtistCountByQualityProfile ?? {}).find(
      ([key]) => normalizeName(key) === normalized,
    )?.[1] ?? 0
  );
}

export function createLidarrPresetDiff(
  pack: LidarrPresetPack,
  state: LidarrPresetLiveState,
  impact: LidarrPresetDiffImpact = {},
): readonly LidarrPresetResourceDiff[] {
  assertLidarrPresetCompatible(pack, state);
  const resources: LidarrPresetResourceDiff[] = [];
  for (const format of pack.customFormats) {
    const current = uniqueNameMatch(state.customFormats, format.name, "customFormats");
    const after = customFormatSemantic(format);
    if (!current) {
      resources.push({
        key: `custom-format:${normalizeName(format.name)}`,
        resource: "custom-format",
        name: format.name,
        dependencies: [],
        impact: {
          kind: "custom-format",
          referencingQualityProfiles: customFormatImpact(format.name, impact),
        },
        action: "create",
        before: null,
        after,
        fieldChanges: [],
      });
      continue;
    }
    const before = customFormatSemantic(current);
    const unchanged = semanticEqual(before, after);
    resources.push({
      key: `custom-format:${normalizeName(format.name)}`,
      resource: "custom-format",
      name: format.name,
      dependencies: [],
      impact: {
        kind: "custom-format",
        referencingQualityProfiles: customFormatImpact(format.name, impact),
      },
      action: unchanged ? "unchanged" : "update",
      liveId: current.id,
      before,
      after,
      fieldChanges: unchanged ? [] : collectFieldChanges(before, after),
    });
  }
  for (const profile of pack.qualityProfiles) {
    const current = uniqueNameMatch(state.qualityProfiles, profile.name, "qualityProfiles");
    const after = desiredProfileSemantic(profile, current);
    const dependencies = profile.formatScores.map(
      ({ customFormatName }) => `custom-format:${normalizeName(customFormatName)}` as const,
    );
    if (!current) {
      resources.push({
        key: `quality-profile:${normalizeName(profile.name)}`,
        resource: "quality-profile",
        name: profile.name,
        dependencies,
        impact: {
          kind: "quality-profile",
          assignedArtistCount: assignedArtistCount(profile.name, impact),
        },
        action: "create",
        before: null,
        after,
        fieldChanges: [],
      });
      continue;
    }
    const before = liveProfileSemantic(current, profile);
    const unchanged = semanticEqual(before, after);
    resources.push({
      key: `quality-profile:${normalizeName(profile.name)}`,
      resource: "quality-profile",
      name: profile.name,
      dependencies,
      impact: {
        kind: "quality-profile",
        assignedArtistCount: assignedArtistCount(profile.name, impact),
      },
      action: unchanged ? "unchanged" : "update",
      liveId: current.id,
      before,
      after,
      fieldChanges: unchanged ? [] : collectFieldChanges(before, after),
    });
  }
  const namingBefore = namingSemantic(state.naming);
  const namingAfter = namingSemantic(pack.naming);
  const namingUnchanged = semanticEqual(namingBefore, namingAfter);
  resources.push({
    key: `naming:${state.naming.id}`,
    resource: "naming",
    name: "Naming",
    dependencies: pack.qualityProfiles.map(
      ({ name }) => `quality-profile:${normalizeName(name)}` as const,
    ),
    impact: { kind: "naming", renamesExistingFiles: false },
    action: namingUnchanged ? "unchanged" : "update",
    liveId: state.naming.id,
    before: namingBefore,
    after: namingAfter,
    fieldChanges: namingUnchanged ? [] : collectFieldChanges(namingBefore, namingAfter),
  });
  const managedFormatNames = new Set(pack.customFormats.map(({ name }) => normalizeName(name)));
  for (const retained of state.customFormats.filter(
    ({ name }) => !managedFormatNames.has(normalizeName(name)),
  )) {
    resources.push({
      key: `custom-format:${normalizeName(retained.name)}`,
      resource: "custom-format",
      name: retained.name,
      dependencies: [],
      impact: {
        kind: "custom-format",
        referencingQualityProfiles: customFormatImpact(retained.name, impact),
      },
      action: "retained",
      liveId: retained.id,
      before: customFormatSemantic(retained),
      after: null,
      fieldChanges: [],
    });
  }
  const managedProfileNames = new Set(pack.qualityProfiles.map(({ name }) => normalizeName(name)));
  for (const retained of state.qualityProfiles.filter(
    ({ name }) => !managedProfileNames.has(normalizeName(name)),
  )) {
    resources.push({
      key: `quality-profile:${normalizeName(retained.name)}`,
      resource: "quality-profile",
      name: retained.name,
      dependencies: [],
      impact: {
        kind: "quality-profile",
        assignedArtistCount: assignedArtistCount(retained.name, impact),
      },
      action: "retained",
      liveId: retained.id,
      before: liveProfileSemantic(retained, {
        name: retained.name,
        upgradeAllowed: retained.upgradeAllowed,
        cutoff: liveCutoffName(retained),
        items: [],
        minFormatScore: retained.minFormatScore,
        cutoffFormatScore: retained.cutoffFormatScore,
        formatScores: [],
      }),
      after: null,
      fieldChanges: [],
    });
  }
  return deepFreeze(resources);
}
