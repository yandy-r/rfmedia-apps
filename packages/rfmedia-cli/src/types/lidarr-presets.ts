/** Generated-independent contracts for Lidarr quality preset discovery, diff, and apply. */

export const LIDARR_PRESET_LIST_VERSION = "rfmedia.lidarr-presets-list.v1";
export const LIDARR_PRESET_SHOW_VERSION = "rfmedia.lidarr-presets-show.v1";
export const LIDARR_PRESET_DIFF_VERSION = "rfmedia.lidarr-presets-diff.v1";
export const LIDARR_PRESET_APPLY_VERSION = "rfmedia.lidarr-presets-apply.v1";
export const LIDARR_PRESET_JOURNAL_VERSION = "rfmedia.lidarr-preset-journal.v1";

/** Runtime validators guarantee that values of this type are positive safe integers. */
export type LidarrPresetResourceId = number;

export type LidarrPresetSource = "builtin" | "config";
export type LidarrPresetReference = `${LidarrPresetSource}:${string}`;
export type LidarrPresetResourceKind = "custom-format" | "quality-profile" | "naming";
export type LidarrPresetResourceKey =
  | `custom-format:${string}`
  | `quality-profile:${string}`
  | `naming:${number}`;

export type LidarrPresetCapability =
  | "custom-format-schema"
  | "custom-format-create"
  | "custom-format-update"
  | "quality-profile-schema"
  | "quality-profile-create"
  | "quality-profile-update"
  | "naming-read"
  | "naming-examples"
  | "naming-update";

export type LidarrPresetCustomFormatImplementation =
  | "ReleaseTitleSpecification"
  | "ReleaseGroupSpecification"
  | "IndexerFlagSpecification"
  | "SizeSpecification";

export type LidarrPresetFieldValue = string | number | boolean;

export interface LidarrPresetCustomFormatSpecification {
  readonly name: string;
  readonly implementation: LidarrPresetCustomFormatImplementation;
  readonly negate: boolean;
  readonly required: boolean;
  readonly fields: Readonly<Record<string, LidarrPresetFieldValue>>;
}

export interface LidarrPresetCustomFormat {
  readonly name: string;
  readonly includeCustomFormatWhenRenaming: boolean;
  readonly specifications: readonly LidarrPresetCustomFormatSpecification[];
}

export type LidarrPresetQualityItem =
  | {
      readonly kind: "quality";
      readonly name: string;
      readonly allowed: boolean;
    }
  | {
      readonly kind: "group";
      readonly name: string;
      readonly allowed: boolean;
      readonly items: readonly LidarrPresetQualityItem[];
    };

export interface LidarrPresetFormatScore {
  readonly customFormatName: string;
  readonly score: number;
}

export interface LidarrPresetQualityProfile {
  readonly name: string;
  readonly upgradeAllowed: boolean;
  readonly cutoff: string;
  readonly items: readonly LidarrPresetQualityItem[];
  readonly minFormatScore: number;
  readonly cutoffFormatScore: number;
  readonly formatScores: readonly LidarrPresetFormatScore[];
}

/** Complete persisted Lidarr naming policy. Derived legacy display fields are excluded. */
export interface LidarrPresetNaming {
  readonly renameTracks: boolean;
  readonly replaceIllegalCharacters: boolean;
  readonly colonReplacementFormat: number;
  readonly standardTrackFormat: string;
  readonly multiDiscTrackFormat: string;
  readonly artistFolderFormat: string;
}

export interface LidarrPresetPackIdentity {
  readonly source: LidarrPresetSource;
  readonly ref: LidarrPresetReference;
  readonly id: string;
  readonly version: number;
  readonly digest: string;
}

export interface LidarrPresetPack extends LidarrPresetPackIdentity {
  readonly provenance: string;
  readonly description: string;
  readonly assumptions: readonly string[];
  readonly consequences: readonly string[];
  readonly capabilities: readonly LidarrPresetCapability[];
  readonly customFormats: readonly LidarrPresetCustomFormat[];
  readonly qualityProfiles: readonly LidarrPresetQualityProfile[];
  readonly naming: LidarrPresetNaming;
}

// ── Rich live projections and write inputs ──

export interface LidarrPresetCustomFormatSpecificationDefinition extends LidarrPresetCustomFormatSpecification {
  readonly id: LidarrPresetResourceId;
}

export interface LidarrPresetCustomFormatDefinition extends Omit<
  LidarrPresetCustomFormat,
  "specifications"
> {
  readonly id: LidarrPresetResourceId;
  readonly specifications: readonly LidarrPresetCustomFormatSpecificationDefinition[];
}

export interface LidarrPresetCustomFormatFieldSchema {
  readonly name: string;
  readonly label: string;
  readonly type: string;
  readonly advanced: boolean;
  readonly selectOptions: readonly {
    readonly value: LidarrPresetFieldValue;
    readonly name: string;
  }[];
}

export interface LidarrPresetCustomFormatSpecificationSchema {
  readonly implementation: LidarrPresetCustomFormatImplementation;
  readonly implementationName: string;
  readonly fields: readonly LidarrPresetCustomFormatFieldSchema[];
}

export interface LidarrPresetCustomFormatCreateInput extends LidarrPresetCustomFormat {
  readonly id?: never;
}

export interface LidarrPresetCustomFormatUpdateInput extends LidarrPresetCustomFormat {
  readonly id: LidarrPresetResourceId;
}

export interface LidarrPresetLiveQualityReference {
  readonly id: LidarrPresetResourceId;
  readonly name: string;
}

export type LidarrPresetLiveQualityItem =
  | {
      readonly kind: "quality";
      readonly id: LidarrPresetResourceId;
      readonly quality: LidarrPresetLiveQualityReference;
      readonly allowed: boolean;
    }
  | {
      readonly kind: "group";
      readonly id: LidarrPresetResourceId;
      readonly name: string;
      readonly allowed: boolean;
      readonly items: readonly LidarrPresetLiveQualityItem[];
    };

export interface LidarrPresetLiveFormatScore {
  readonly customFormat: LidarrPresetLiveQualityReference;
  readonly score: number;
}

export interface LidarrPresetQualityProfileDefinition {
  readonly id: LidarrPresetResourceId;
  readonly name: string;
  readonly upgradeAllowed: boolean;
  readonly cutoff: LidarrPresetResourceId;
  readonly items: readonly LidarrPresetLiveQualityItem[];
  readonly minFormatScore: number;
  readonly cutoffFormatScore: number;
  readonly formatItems: readonly LidarrPresetLiveFormatScore[];
}

export interface LidarrPresetQualityProfileSchema {
  readonly items: readonly LidarrPresetLiveQualityItem[];
  readonly formatItems: readonly LidarrPresetLiveFormatScore[];
}

export interface LidarrPresetQualityProfileCreateInput {
  readonly id?: never;
  readonly name: string;
  readonly upgradeAllowed: boolean;
  readonly cutoff: LidarrPresetResourceId;
  readonly items: readonly LidarrPresetLiveQualityItem[];
  readonly minFormatScore: number;
  readonly cutoffFormatScore: number;
  readonly formatItems: readonly LidarrPresetLiveFormatScore[];
}

export interface LidarrPresetQualityProfileUpdateInput extends Omit<
  LidarrPresetQualityProfileCreateInput,
  "id"
> {
  readonly id: LidarrPresetResourceId;
}

export interface LidarrPresetNamingConfig extends LidarrPresetNaming {
  readonly id: LidarrPresetResourceId;
}

export interface LidarrPresetNamingUpdateInput extends LidarrPresetNaming {
  readonly id: LidarrPresetResourceId;
}

export interface LidarrPresetNamingExamples {
  readonly singleTrackExample: string;
  readonly multiDiscTrackExample: string;
  readonly artistFolderExample: string;
  readonly albumFolderExample: string;
}

// ── Semantic diff and impact ──

export type LidarrPresetSemanticValue =
  | string
  | number
  | boolean
  | null
  | readonly LidarrPresetSemanticValue[]
  | { readonly [key: string]: LidarrPresetSemanticValue };

export interface LidarrPresetSemanticFieldChange {
  readonly path: string;
  readonly before: LidarrPresetSemanticValue;
  readonly after: LidarrPresetSemanticValue;
}

export type LidarrPresetResourceImpact =
  | {
      readonly kind: "custom-format";
      readonly referencingQualityProfiles: readonly string[];
    }
  | {
      readonly kind: "quality-profile";
      readonly assignedArtistCount: number;
    }
  | {
      readonly kind: "naming";
      readonly renamesExistingFiles: false;
    };

interface LidarrPresetResourceDiffBase {
  readonly key: LidarrPresetResourceKey;
  readonly resource: LidarrPresetResourceKind;
  readonly name: string;
  readonly dependencies: readonly LidarrPresetResourceKey[];
  readonly impact: LidarrPresetResourceImpact;
  readonly fieldChanges: readonly LidarrPresetSemanticFieldChange[];
}

export type LidarrPresetResourceDiff =
  | (LidarrPresetResourceDiffBase & {
      readonly action: "create";
      readonly liveId?: never;
      readonly before: null;
      readonly after: LidarrPresetSemanticValue;
    })
  | (LidarrPresetResourceDiffBase & {
      readonly action: "update" | "unchanged";
      readonly liveId: LidarrPresetResourceId;
      readonly before: LidarrPresetSemanticValue;
      readonly after: LidarrPresetSemanticValue;
    })
  | (LidarrPresetResourceDiffBase & {
      readonly action: "retained";
      readonly liveId: LidarrPresetResourceId;
      readonly before: LidarrPresetSemanticValue;
      readonly after: null;
    });

export interface LidarrPresetDiffSummary {
  readonly total: number;
  readonly create: number;
  readonly update: number;
  readonly unchanged: number;
  readonly retained: number;
}

export interface LidarrPresetExecutionMetadata {
  readonly operation: string;
  readonly lane: "local-only" | "destructive";
  readonly attempts: number;
  readonly outcome: "succeeded" | "failed" | "skipped";
}

export interface LidarrPresetListResult {
  readonly schemaVersion: typeof LIDARR_PRESET_LIST_VERSION;
  readonly packs: readonly LidarrPresetPack[];
}

export interface LidarrPresetShowResult {
  readonly schemaVersion: typeof LIDARR_PRESET_SHOW_VERSION;
  readonly pack: LidarrPresetPack;
}

export interface LidarrPresetDiffResult {
  readonly schemaVersion: typeof LIDARR_PRESET_DIFF_VERSION;
  readonly pack: LidarrPresetPackIdentity;
  readonly targetOrigin: string;
  readonly assumptions: readonly string[];
  readonly consequences: readonly string[];
  readonly observations: readonly string[];
  readonly warnings: readonly string[];
  readonly hasChanges: boolean;
  readonly summary: LidarrPresetDiffSummary;
  readonly resources: readonly LidarrPresetResourceDiff[];
  readonly namingExamples: LidarrPresetNamingExamples;
  readonly execution: readonly LidarrPresetExecutionMetadata[];
}

// ── Apply outcomes and durable journal ──

export type LidarrPresetApplyOutcomeStatus =
  | "succeeded"
  | "satisfied"
  | "failed"
  | "uncertain"
  | "not-attempted";

export type LidarrPresetDispatchState = "not-dispatched" | "dispatched" | "dispatch-unknown";
export type LidarrPresetVerificationState = "not-started" | "verified" | "failed" | "inconclusive";

export interface LidarrPresetSafeError {
  readonly code: string;
  readonly phase: string;
  readonly resourcePath: string;
  readonly retryable: boolean;
  readonly nextAction: string;
}

interface LidarrPresetApplyOutcomeBase {
  readonly key: LidarrPresetResourceKey;
  readonly resource: LidarrPresetResourceKind;
  readonly name: string;
}

export type LidarrPresetApplyOutcome =
  | (LidarrPresetApplyOutcomeBase & {
      readonly outcome: "succeeded";
      readonly attempted: true;
      readonly dispatchState: "dispatched";
      readonly verificationState: "verified";
    })
  | (LidarrPresetApplyOutcomeBase & {
      readonly outcome: "satisfied";
      readonly attempted: boolean;
      readonly dispatchState: LidarrPresetDispatchState;
      readonly verificationState: "verified";
    })
  | (LidarrPresetApplyOutcomeBase & {
      readonly outcome: "failed";
      readonly attempted: boolean;
      readonly dispatchState: LidarrPresetDispatchState;
      readonly verificationState: "not-started" | "failed";
      readonly error: LidarrPresetSafeError;
    })
  | (LidarrPresetApplyOutcomeBase & {
      readonly outcome: "uncertain";
      readonly attempted: true;
      readonly dispatchState: "dispatched" | "dispatch-unknown";
      readonly verificationState: "inconclusive";
      readonly error: LidarrPresetSafeError;
    })
  | (LidarrPresetApplyOutcomeBase & {
      readonly outcome: "not-attempted";
      readonly attempted: false;
      readonly dispatchState: "not-dispatched";
      readonly verificationState: "not-started";
      readonly blockedBy: LidarrPresetResourceKey;
    });

export interface LidarrPresetApplySummary {
  readonly total: number;
  readonly succeeded: number;
  readonly satisfied: number;
  readonly failed: number;
  readonly uncertain: number;
  readonly notAttempted: number;
}

export interface LidarrPresetApplyResult {
  readonly schemaVersion: typeof LIDARR_PRESET_APPLY_VERSION;
  readonly dryRun: boolean;
  readonly status: "checked" | "declined" | "completed" | "partial" | "failed";
  readonly review: LidarrPresetDiffResult;
  readonly summary: LidarrPresetApplySummary;
  readonly outcomes: readonly LidarrPresetApplyOutcome[];
  readonly execution: readonly LidarrPresetExecutionMetadata[];
  readonly error?: LidarrPresetSafeError;
}

export type LidarrPresetJournalResourceState =
  | {
      readonly state: "pending";
      readonly resource: LidarrPresetResourceDiff;
    }
  | {
      readonly state: "dispatching";
      readonly resource: LidarrPresetResourceDiff;
      readonly dispatchStartedAt: string;
    }
  | {
      readonly state: "terminal";
      readonly resource: LidarrPresetResourceDiff;
      readonly outcome: LidarrPresetApplyOutcome;
      readonly recordedAt: string;
    };

export interface LidarrPresetApplyJournal {
  readonly schemaVersion: typeof LIDARR_PRESET_JOURNAL_VERSION;
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: "in-progress" | "completed" | "partial" | "failed" | "uncertain";
  readonly pack: LidarrPresetPackIdentity;
  readonly targetOrigin: string;
  readonly resources: readonly LidarrPresetJournalResourceState[];
}
