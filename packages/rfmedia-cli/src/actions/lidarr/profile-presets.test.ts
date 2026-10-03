import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LidarrConfigOptions } from "../../types/config.js";

const state = vi.hoisted(() => ({
  client: undefined as unknown,
  config: {} as LidarrConfigOptions,
}));
const mockResolveOrigin = vi.hoisted(() => vi.fn(() => "https://lidarr.example.test"));
const mockResolveContext = vi.hoisted(() =>
  vi.fn(() => ({
    client: state.client,
    preflight: vi.fn(),
    writeLookupCache: vi.fn(),
    tryServeStale: vi.fn(),
  })),
);
const mockRunSingle = vi.hoisted(() =>
  vi.fn(
    async (
      lane: string,
      task: {
        id: string;
        operation: string;
        idempotent: boolean;
        run: () => Promise<unknown>;
      },
      _options?: unknown,
    ) => ({
      value: await task.run(),
      execution: {
        taskId: "lidarr-presets-diff",
        operation: task.operation,
        lane,
        outcome: "succeeded" as const,
        attempts: 1,
      },
    }),
  ),
);
const mockAcquireLock = vi.hoisted(() => vi.fn());
const mockCreateJournal = vi.hoisted(() => vi.fn());
const mockSignalHandler = vi.hoisted(() => ({
  controller: new AbortController(),
  cleanup: new Map<string, () => Promise<void>>(),
  registerGlobalCleanup: vi.fn(
    (handler: { name: string; cleanup: () => Promise<void> }) =>
      void mockSignalHandler.cleanup.set(handler.name, handler.cleanup),
  ),
  unregisterGlobalCleanup: vi.fn((name: string) => void mockSignalHandler.cleanup.delete(name)),
}));

vi.mock("../../lib/loaded-config.js", () => ({
  getLoadedLidarrConfig: () => state.config,
}));

vi.mock("../../lib/lidarr/index.js", () => ({
  resolveLidarrScheduler: () => ({ runSingle: mockRunSingle }),
  resolveRequiredLidarrExecutionContext: mockResolveContext,
  resolveRequiredLidarrOrigin: mockResolveOrigin,
}));

vi.mock("../../lib/lidarr/profile-preset-persistence.js", () => ({
  acquireLidarrPresetApplyLock: mockAcquireLock,
  createLidarrPresetApplyJournal: mockCreateJournal,
}));

vi.mock("../../lib/signal-handler.js", () => ({
  getGlobalSignal: () => mockSignalHandler.controller.signal,
  registerGlobalCleanup: mockSignalHandler.registerGlobalCleanup,
  unregisterGlobalCleanup: mockSignalHandler.unregisterGlobalCleanup,
}));

import { createLidarrArtistFixture } from "../test-helpers/lidarr-fixtures.js";
import { createLidarrClientMock } from "../test-helpers/lidarr-client-mocks.js";
import {
  BUILTIN_LIDARR_PRESET_PACKS,
  LIDARR_PRESET_SUPPORTED_FIXTURE_V1,
  buildLidarrPresetQualityProfileInput,
} from "../../lib/lidarr/profile-presets.js";
import type {
  LidarrPresetCustomFormatDefinition,
  LidarrPresetLiveFormatScore,
  LidarrPresetNamingConfig,
  LidarrPresetQualityProfileDefinition,
} from "../../types/lidarr-presets.js";
import {
  executeLidarrPresetApply,
  executeLidarrPresetDiff,
  executeLidarrPresetList,
  executeLidarrPresetShow,
} from "./profile-presets.js";

const pack = BUILTIN_LIDARR_PRESET_PACKS[0]!;

function makeCustomFormat(): LidarrPresetCustomFormatDefinition {
  return Object.freeze({
    ...structuredClone(pack.customFormats[0]!),
    id: 501,
    specifications: Object.freeze(
      pack.customFormats[0]!.specifications.map((specification, index) =>
        Object.freeze({ ...structuredClone(specification), id: 5_010 + index }),
      ),
    ),
  });
}

function makeLiveClient() {
  const customFormat = makeCustomFormat();
  const formatItems: readonly LidarrPresetLiveFormatScore[] = Object.freeze([
    Object.freeze({
      customFormat: Object.freeze({ id: customFormat.id, name: customFormat.name }),
      score: 0,
    }),
  ]);
  const qualityProfileSchema = Object.freeze({
    ...LIDARR_PRESET_SUPPORTED_FIXTURE_V1.qualityProfileSchema,
    formatItems,
  });
  const qualityProfile: LidarrPresetQualityProfileDefinition = Object.freeze({
    ...buildLidarrPresetQualityProfileInput(
      pack.qualityProfiles[0]!,
      qualityProfileSchema,
      undefined,
    ),
    id: 601,
  });
  return createLidarrClientMock({
    getCustomFormatSchema: () =>
      Promise.resolve(LIDARR_PRESET_SUPPORTED_FIXTURE_V1.customFormatSchema),
    listCustomFormats: () => Promise.resolve(Object.freeze([customFormat])),
    getQualityProfileSchema: () => Promise.resolve(qualityProfileSchema),
    listQualityProfileDefinitions: () => Promise.resolve(Object.freeze([qualityProfile])),
    getNamingConfig: () =>
      Promise.resolve(
        Object.freeze({
          id: 1,
          ...structuredClone(pack.naming),
        }),
      ),
    getNamingExamples: () =>
      Promise.resolve(
        Object.freeze({
          singleTrackExample: "01 - Track",
          multiDiscTrackExample: "1-01 - Track",
          artistFolderExample: "Artist",
          albumFolderExample: "Album",
        }),
      ),
    listArtists: () =>
      Promise.resolve(
        Object.freeze([
          createLidarrArtistFixture({ id: 1, qualityProfileId: qualityProfile.id }),
          createLidarrArtistFixture({ id: 2, qualityProfileId: qualityProfile.id }),
        ]),
      ),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSignalHandler.controller = new AbortController();
  mockSignalHandler.cleanup.clear();
  state.config = {};
  state.client = makeLiveClient();
  mockAcquireLock.mockResolvedValue({
    path: "/tmp/preset.lock",
    originDigest: "a".repeat(64),
    assertOwned: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
  });
  mockCreateJournal.mockResolvedValue({
    path: "/tmp/preset.json",
    transition: vi.fn().mockResolvedValue(undefined),
    finalize: vi.fn().mockResolvedValue(undefined),
  });
});

describe("offline Lidarr preset discovery", () => {
  it("lists and shows local packs without resolving credentials, client, scheduler, or storage", async () => {
    const list = await executeLidarrPresetList();
    const shown = await executeLidarrPresetShow({ packRef: "builtin:balanced" });

    expect(list.schemaVersion).toBe("rfmedia.lidarr-presets-list.v1");
    expect(list.packs.map(({ ref }) => ref)).toEqual([
      "builtin:balanced",
      "builtin:lossless",
      "builtin:space-saver",
    ]);
    expect(shown.schemaVersion).toBe("rfmedia.lidarr-presets-show.v1");
    expect(shown.pack.ref).toBe("builtin:balanced");
    expect(mockResolveOrigin).not.toHaveBeenCalled();
    expect(mockResolveContext).not.toHaveBeenCalled();
    expect(mockRunSingle).not.toHaveBeenCalled();
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(mockCreateJournal).not.toHaveBeenCalled();
  });
});

describe("fresh Lidarr preset diff", () => {
  it("reads the complete fresh state and returns deterministic resource impact", async () => {
    const client = state.client as ReturnType<typeof createLidarrClientMock>;
    const signal = new AbortController().signal;

    const result = await executeLidarrPresetDiff({
      packRef: "builtin:balanced",
      lidarrUrl: "https://lidarr.example.test",
      lidarrApiKey: "test-key",
      signal,
    });

    expect(mockResolveContext).toHaveBeenCalledWith(
      {
        lidarrUrl: "https://lidarr.example.test",
        lidarrApiKey: "test-key",
      },
      {
        tier: "local-only",
        allowStale: false,
        retryAttemptsOverride: 0,
      },
    );
    expect(mockRunSingle).toHaveBeenCalledWith(
      "local-only",
      expect.objectContaining({ id: "lidarr-presets-diff", idempotent: true }),
      { signal },
    );
    for (const read of [
      client.getCustomFormatSchema,
      client.listCustomFormats,
      client.getQualityProfileSchema,
      client.listQualityProfileDefinitions,
      client.getNamingConfig,
      client.listArtists,
    ]) {
      expect(read).toHaveBeenCalledWith(signal);
    }
    expect(client.getNamingExamples).toHaveBeenCalledWith({ id: 1, ...pack.naming }, signal);

    expect(result.schemaVersion).toBe("rfmedia.lidarr-presets-diff.v1");
    expect(result.targetOrigin).toBe("https://lidarr.example.test");
    expect(result.summary).toEqual({
      total: 3,
      create: 0,
      update: 0,
      unchanged: 3,
      retained: 0,
    });
    expect(result.hasChanges).toBe(false);
    expect(result.resources[0]!.impact).toEqual({
      kind: "custom-format",
      referencingQualityProfiles: ["RFMedia Balanced"],
    });
    expect(result.resources[1]!.impact).toEqual({
      kind: "quality-profile",
      assignedArtistCount: 2,
    });
    expect(result.execution).toEqual([
      {
        operation: "lidarr presets diff",
        lane: "local-only",
        attempts: 1,
        outcome: "succeeded",
      },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(client.createCustomFormat).not.toHaveBeenCalled();
    expect(client.updateCustomFormat).not.toHaveBeenCalled();
    expect(client.createQualityProfile).not.toHaveBeenCalled();
    expect(client.updateQualityProfile).not.toHaveBeenCalled();
    expect(client.updateNamingConfig).not.toHaveBeenCalled();
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(mockCreateJournal).not.toHaveBeenCalled();
  });

  it("fails closed on incompatible live schema before any mutation or persistence", async () => {
    const client = makeLiveClient();
    client.getCustomFormatSchema.mockResolvedValue(Object.freeze([]));
    state.client = client;

    await expect(executeLidarrPresetDiff({ packRef: "builtin:balanced" })).rejects.toThrow(
      /must resolve exactly once/iu,
    );

    expect(client.createCustomFormat).not.toHaveBeenCalled();
    expect(client.updateCustomFormat).not.toHaveBeenCalled();
    expect(client.createQualityProfile).not.toHaveBeenCalled();
    expect(client.updateQualityProfile).not.toHaveBeenCalled();
    expect(client.updateNamingConfig).not.toHaveBeenCalled();
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(mockCreateJournal).not.toHaveBeenCalled();
  });

  it("keeps create, update, unchanged, and retained classification stable", async () => {
    const client = makeLiveClient();
    const managedFormat = makeCustomFormat();
    const retainedFormat: LidarrPresetCustomFormatDefinition = Object.freeze({
      id: 777,
      name: "Unmanaged Format",
      includeCustomFormatWhenRenaming: false,
      specifications: Object.freeze([]),
    });
    client.listCustomFormats.mockResolvedValue(
      Object.freeze([
        Object.freeze({
          ...managedFormat,
          includeCustomFormatWhenRenaming: !managedFormat.includeCustomFormatWhenRenaming,
        }),
        retainedFormat,
      ]),
    );
    const retainedProfile: LidarrPresetQualityProfileDefinition = Object.freeze({
      id: 778,
      name: "Unmanaged Profile",
      upgradeAllowed: false,
      cutoff: LIDARR_PRESET_SUPPORTED_FIXTURE_V1.qualityProfileSchema.items[0]!.id,
      items: LIDARR_PRESET_SUPPORTED_FIXTURE_V1.qualityProfileSchema.items,
      minFormatScore: 0,
      cutoffFormatScore: 0,
      formatItems: Object.freeze([
        Object.freeze({
          customFormat: Object.freeze({ id: retainedFormat.id, name: retainedFormat.name }),
          score: 10,
        }),
      ]),
    });
    client.listQualityProfileDefinitions.mockResolvedValue(Object.freeze([retainedProfile]));
    client.listArtists.mockResolvedValue(
      Object.freeze([createLidarrArtistFixture({ id: 1, qualityProfileId: retainedProfile.id })]),
    );
    state.client = client;

    const result = await executeLidarrPresetDiff({ packRef: "builtin:balanced" });

    expect(result.resources.map(({ action }) => action)).toEqual([
      "update",
      "create",
      "unchanged",
      "retained",
      "retained",
    ]);
    expect(result.summary).toEqual({
      total: 5,
      create: 1,
      update: 1,
      unchanged: 1,
      retained: 2,
    });
    expect(result.hasChanges).toBe(true);
    expect(result.resources[3]!.impact).toEqual({
      kind: "custom-format",
      referencingQualityProfiles: ["Unmanaged Profile"],
    });
    expect(result.resources[4]!.impact).toEqual({
      kind: "quality-profile",
      assignedArtistCount: 1,
    });
    expect(client.createCustomFormat).not.toHaveBeenCalled();
    expect(client.updateCustomFormat).not.toHaveBeenCalled();
    expect(client.createQualityProfile).not.toHaveBeenCalled();
    expect(client.updateQualityProfile).not.toHaveBeenCalled();
    expect(client.updateNamingConfig).not.toHaveBeenCalled();
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(mockCreateJournal).not.toHaveBeenCalled();
  });
});

describe("verified Lidarr preset apply", () => {
  function makeNamingChangeClient() {
    const client = makeLiveClient();
    client.getNamingConfig.mockResolvedValue(
      Object.freeze({
        id: 1,
        ...structuredClone(pack.naming),
        renameTracks: !pack.naming.renameTracks,
      }),
    );
    return client;
  }

  function makeFormatAndNamingChangeClient() {
    const client = makeNamingChangeClient();
    const customFormat = makeCustomFormat();
    client.listCustomFormats.mockResolvedValue(
      Object.freeze([
        Object.freeze({
          ...customFormat,
          includeCustomFormatWhenRenaming: !customFormat.includeCustomFormatWhenRenaming,
        }),
      ]),
    );
    return client;
  }

  it("delegates dry-run to the complete live diff with zero confirmation, lock, journal, or mutation", async () => {
    const client = makeNamingChangeClient();
    state.client = client;
    const confirm = vi.fn().mockResolvedValue(true);

    const result = await executeLidarrPresetApply({
      packRef: "builtin:balanced",
      dryRun: true,
      confirm,
    });

    expect(result.status).toBe("checked");
    expect(result.dryRun).toBe(true);
    expect(result.review.hasChanges).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(mockCreateJournal).not.toHaveBeenCalled();
    expect(client.updateNamingConfig).not.toHaveBeenCalled();
  });

  it("returns a converged real apply before confirmation, lock, journal, or mutation", async () => {
    const client = makeLiveClient();
    state.client = client;
    const confirm = vi.fn().mockResolvedValue(true);

    const result = await executeLidarrPresetApply({
      packRef: "builtin:balanced",
      confirm,
    });

    expect(result.status).toBe("completed");
    expect(result.summary).toEqual({
      total: 3,
      succeeded: 0,
      satisfied: 3,
      failed: 0,
      uncertain: 0,
      notAttempted: 0,
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(mockCreateJournal).not.toHaveBeenCalled();
  });

  it("repeats preflight and confirms while retaining the lock, then declines without a journal", async () => {
    const client = makeNamingChangeClient();
    state.client = client;
    const lock = await mockAcquireLock();
    mockAcquireLock.mockClear();
    mockAcquireLock.mockResolvedValue(lock);
    const confirm = vi.fn(async () => {
      expect(lock.release).not.toHaveBeenCalled();
      expect(mockRunSingle).toHaveBeenCalledTimes(2);
      return false;
    });

    const result = await executeLidarrPresetApply({
      packRef: "builtin:balanced",
      confirm,
    });

    expect(result.status).toBe("declined");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(mockAcquireLock).toHaveBeenCalledWith("https://lidarr.example.test");
    expect(mockCreateJournal).not.toHaveBeenCalled();
    expect(client.updateNamingConfig).not.toHaveBeenCalled();
    expect(lock.release).toHaveBeenCalledTimes(1);
    expect(mockSignalHandler.cleanup.size).toBe(0);
  });

  it("applies formats, refreshed profile bodies, and naming in ordered destructive writes", async () => {
    let customFormats: readonly LidarrPresetCustomFormatDefinition[] = Object.freeze([]);
    let qualityProfiles: readonly LidarrPresetQualityProfileDefinition[] = Object.freeze([]);
    let naming: LidarrPresetNamingConfig = Object.freeze({
      id: 1,
      ...structuredClone(pack.naming),
      renameTracks: !pack.naming.renameTracks,
    });
    const client = makeLiveClient();
    client.listCustomFormats.mockImplementation(() => Promise.resolve(customFormats));
    client.listQualityProfileDefinitions.mockImplementation(() => Promise.resolve(qualityProfiles));
    client.listArtists.mockResolvedValue(Object.freeze([]));
    client.getQualityProfileSchema.mockImplementation(() =>
      Promise.resolve(
        Object.freeze({
          ...LIDARR_PRESET_SUPPORTED_FIXTURE_V1.qualityProfileSchema,
          formatItems: Object.freeze(
            customFormats.map(({ id, name }) =>
              Object.freeze({
                customFormat: Object.freeze({ id, name }),
                score: 0,
              }),
            ),
          ),
        }),
      ),
    );
    client.createCustomFormat.mockImplementation((input) => {
      const created: LidarrPresetCustomFormatDefinition = Object.freeze({
        ...structuredClone(input),
        id: 701,
        specifications: Object.freeze(
          input.specifications.map((specification, index) =>
            Object.freeze({ ...structuredClone(specification), id: 7_010 + index }),
          ),
        ),
      });
      customFormats = Object.freeze([created]);
      return Promise.resolve(created);
    });
    client.createQualityProfile.mockImplementation((input) => {
      const created: LidarrPresetQualityProfileDefinition = Object.freeze({
        ...structuredClone(input),
        id: 702,
      });
      qualityProfiles = Object.freeze([created]);
      return Promise.resolve(created);
    });
    client.getNamingConfig.mockImplementation(() => Promise.resolve(naming));
    client.updateNamingConfig.mockImplementation((input) => {
      naming = Object.freeze({ ...input });
      return Promise.resolve(naming);
    });
    state.client = client;
    const journal = {
      path: "/tmp/preset.json",
      transition: vi.fn().mockResolvedValue(undefined),
      finalize: vi.fn().mockResolvedValue(undefined),
    };
    mockCreateJournal.mockResolvedValue(journal);

    const result = await executeLidarrPresetApply({
      packRef: "builtin:balanced",
      confirm: vi.fn().mockResolvedValue(true),
    });

    expect(result.status).toBe("completed");
    expect(result.outcomes.map(({ outcome }) => outcome)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(client.createCustomFormat).toHaveBeenCalledTimes(1);
    expect(client.createQualityProfile).toHaveBeenCalledTimes(1);
    expect(client.updateNamingConfig).toHaveBeenCalledTimes(1);
    expect(
      mockRunSingle.mock.calls
        .filter(([lane]) => lane === "destructive")
        .map(([, task]) => ({ id: task.id, idempotent: task.idempotent })),
    ).toEqual([
      { id: "lidarr-presets-apply-custom-format:rfmedia web source", idempotent: false },
      { id: "lidarr-presets-apply-quality-profile:rfmedia balanced", idempotent: false },
      { id: "lidarr-presets-apply-naming:1", idempotent: false },
    ]);
    expect(
      result.execution
        .filter(({ lane }) => lane === "destructive")
        .map(({ operation, lane }) => ({ operation, lane })),
    ).toEqual([
      {
        operation: "lidarr presets apply custom-format:rfmedia web source",
        lane: "destructive",
      },
      {
        operation: "lidarr presets apply quality-profile:rfmedia balanced",
        lane: "destructive",
      },
      { operation: "lidarr presets apply naming:1", lane: "destructive" },
    ]);
    expect(client.createQualityProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        formatItems: [
          expect.objectContaining({
            customFormat: { id: 701, name: pack.customFormats[0]!.name },
            score: pack.qualityProfiles[0]!.formatScores[0]!.score,
          }),
        ],
      }),
      expect.any(AbortSignal),
    );
    expect(mockResolveContext).toHaveBeenCalledWith(
      { lidarrUrl: undefined, lidarrApiKey: undefined },
      { tier: "destructive", allowStale: false, retryAttemptsOverride: 0 },
    );
    expect(journal.transition).toHaveBeenCalledTimes(6);
    expect(journal.finalize).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));

    const secondConfirm = vi.fn().mockResolvedValue(true);
    const second = await executeLidarrPresetApply({
      packRef: "builtin:balanced",
      confirm: secondConfirm,
    });
    expect(second.status).toBe("completed");
    expect(secondConfirm).not.toHaveBeenCalled();
    expect(client.createCustomFormat).toHaveBeenCalledTimes(1);
    expect(client.createQualityProfile).toHaveBeenCalledTimes(1);
    expect(client.updateNamingConfig).toHaveBeenCalledTimes(1);
    expect(mockAcquireLock).toHaveBeenCalledTimes(1);
  });

  it("rebases an existing profile baseline after creating its missing managed format", async () => {
    const client = makeLiveClient();
    const existingProfile = (await client.listQualityProfileDefinitions())[0]!;
    let customFormats: readonly LidarrPresetCustomFormatDefinition[] = Object.freeze([]);
    let qualityProfiles: readonly LidarrPresetQualityProfileDefinition[] = Object.freeze([
      Object.freeze({ ...existingProfile, formatItems: Object.freeze([]) }),
    ]);
    client.listCustomFormats.mockImplementation(() => Promise.resolve(customFormats));
    client.listQualityProfileDefinitions.mockImplementation(() => Promise.resolve(qualityProfiles));
    client.getQualityProfileSchema.mockImplementation(() =>
      Promise.resolve(
        Object.freeze({
          ...LIDARR_PRESET_SUPPORTED_FIXTURE_V1.qualityProfileSchema,
          formatItems: Object.freeze(
            customFormats.map(({ id, name }) =>
              Object.freeze({
                customFormat: Object.freeze({ id, name }),
                score: 0,
              }),
            ),
          ),
        }),
      ),
    );
    client.createCustomFormat.mockImplementation((input) => {
      const created: LidarrPresetCustomFormatDefinition = Object.freeze({
        ...structuredClone(input),
        id: 701,
        specifications: Object.freeze(
          input.specifications.map((specification, index) =>
            Object.freeze({ ...structuredClone(specification), id: 7_010 + index }),
          ),
        ),
      });
      customFormats = Object.freeze([created]);
      qualityProfiles = Object.freeze(
        qualityProfiles.map((profile) =>
          Object.freeze({
            ...profile,
            formatItems: Object.freeze([
              Object.freeze({
                customFormat: Object.freeze({ id: created.id, name: created.name }),
                score: 0,
              }),
            ]),
          }),
        ),
      );
      return Promise.resolve(created);
    });
    client.updateQualityProfile.mockImplementation((input) => {
      const updated = Object.freeze({ ...structuredClone(input) });
      qualityProfiles = Object.freeze([updated]);
      return Promise.resolve(updated);
    });
    state.client = client;

    const result = await executeLidarrPresetApply({
      packRef: "builtin:balanced",
      confirm: vi.fn().mockResolvedValue(true),
    });

    expect(result.status).toBe("completed");
    expect(result.outcomes.map(({ outcome }) => outcome)).toEqual([
      "succeeded",
      "succeeded",
      "satisfied",
    ]);
    expect(client.createCustomFormat).toHaveBeenCalledTimes(1);
    expect(client.updateQualityProfile).toHaveBeenCalledTimes(1);
    expect(
      result.outcomes.some(
        (outcome) => "error" in outcome && outcome.error.code === "LIDARR_PRESET_STALE",
      ),
    ).toBe(false);
  });

  it("rejects unrelated profile drift observed with a newly created managed format", async () => {
    const client = makeLiveClient();
    const existingProfile = (await client.listQualityProfileDefinitions())[0]!;
    let customFormats: readonly LidarrPresetCustomFormatDefinition[] = Object.freeze([]);
    let qualityProfiles: readonly LidarrPresetQualityProfileDefinition[] = Object.freeze([
      Object.freeze({ ...existingProfile, formatItems: Object.freeze([]) }),
    ]);
    client.listCustomFormats.mockImplementation(() => Promise.resolve(customFormats));
    client.listQualityProfileDefinitions.mockImplementation(() => Promise.resolve(qualityProfiles));
    client.getQualityProfileSchema.mockImplementation(() =>
      Promise.resolve(
        Object.freeze({
          ...LIDARR_PRESET_SUPPORTED_FIXTURE_V1.qualityProfileSchema,
          formatItems: Object.freeze(
            customFormats.map(({ id, name }) =>
              Object.freeze({
                customFormat: Object.freeze({ id, name }),
                score: 0,
              }),
            ),
          ),
        }),
      ),
    );
    client.createCustomFormat.mockImplementation((input) => {
      const created: LidarrPresetCustomFormatDefinition = Object.freeze({
        ...structuredClone(input),
        id: 701,
        specifications: Object.freeze(
          input.specifications.map((specification, index) =>
            Object.freeze({ ...structuredClone(specification), id: 7_010 + index }),
          ),
        ),
      });
      customFormats = Object.freeze([created]);
      qualityProfiles = Object.freeze(
        qualityProfiles.map((profile) =>
          Object.freeze({
            ...profile,
            minFormatScore: profile.minFormatScore + 1,
            formatItems: Object.freeze([
              Object.freeze({
                customFormat: Object.freeze({ id: created.id, name: created.name }),
                score: 0,
              }),
            ]),
          }),
        ),
      );
      return Promise.resolve(created);
    });
    state.client = client;

    const result = await executeLidarrPresetApply({
      packRef: "builtin:balanced",
      confirm: vi.fn().mockResolvedValue(true),
    });

    expect(result.status).toBe("partial");
    expect(result.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "custom-format:rfmedia web source",
          outcome: "succeeded",
        }),
        expect.objectContaining({
          key: "quality-profile:rfmedia balanced",
          outcome: "failed",
          attempted: false,
          error: expect.objectContaining({ code: "LIDARR_PRESET_STALE" }),
        }),
      ]),
    );
    expect(client.updateQualityProfile).not.toHaveBeenCalled();
  });

  it("continues later resources when a thrown dispatch is proven converged", async () => {
    let customFormats: readonly LidarrPresetCustomFormatDefinition[] = Object.freeze([]);
    let qualityProfiles: readonly LidarrPresetQualityProfileDefinition[] = Object.freeze([]);
    let naming: LidarrPresetNamingConfig = Object.freeze({
      id: 1,
      ...structuredClone(pack.naming),
      renameTracks: !pack.naming.renameTracks,
    });
    const client = makeLiveClient();
    client.listCustomFormats.mockImplementation(() => Promise.resolve(customFormats));
    client.listQualityProfileDefinitions.mockImplementation(() => Promise.resolve(qualityProfiles));
    client.listArtists.mockResolvedValue(Object.freeze([]));
    client.getQualityProfileSchema.mockImplementation(() =>
      Promise.resolve(
        Object.freeze({
          ...LIDARR_PRESET_SUPPORTED_FIXTURE_V1.qualityProfileSchema,
          formatItems: Object.freeze(
            customFormats.map(({ id, name }) =>
              Object.freeze({
                customFormat: Object.freeze({ id, name }),
                score: 0,
              }),
            ),
          ),
        }),
      ),
    );
    client.createCustomFormat.mockImplementation(async (input) => {
      const created: LidarrPresetCustomFormatDefinition = Object.freeze({
        ...structuredClone(input),
        id: 701,
        specifications: Object.freeze(
          input.specifications.map((specification, index) =>
            Object.freeze({ ...structuredClone(specification), id: 7_010 + index }),
          ),
        ),
      });
      customFormats = Object.freeze([created]);
      throw new Error("connection reset after create");
    });
    client.createQualityProfile.mockImplementation((input) => {
      const created: LidarrPresetQualityProfileDefinition = Object.freeze({
        ...structuredClone(input),
        id: 702,
      });
      qualityProfiles = Object.freeze([created]);
      return Promise.resolve(created);
    });
    client.getNamingConfig.mockImplementation(() => Promise.resolve(naming));
    client.updateNamingConfig.mockImplementation((input) => {
      naming = Object.freeze({ ...input });
      return Promise.resolve(naming);
    });
    state.client = client;

    const result = await executeLidarrPresetApply({
      packRef: "builtin:balanced",
      confirm: vi.fn().mockResolvedValue(true),
    });

    expect(result.status).toBe("completed");
    expect(result.outcomes.map(({ outcome }) => outcome)).toEqual([
      "satisfied",
      "succeeded",
      "succeeded",
    ]);
    expect(result.outcomes[0]).toEqual(
      expect.objectContaining({
        attempted: true,
        dispatchState: "dispatch-unknown",
        verificationState: "verified",
      }),
    );
    expect(client.createCustomFormat).toHaveBeenCalledTimes(1);
    expect(client.createQualityProfile).toHaveBeenCalledTimes(1);
    expect(client.updateNamingConfig).toHaveBeenCalledTimes(1);
  });

  it("stops before dispatch when the reviewed resource drifts under the lock", async () => {
    const client = makeNamingChangeClient();
    let namingReads = 0;
    client.getNamingConfig.mockImplementation(() => {
      namingReads += 1;
      return Promise.resolve(
        Object.freeze({
          id: 1,
          ...structuredClone(pack.naming),
          renameTracks: namingReads < 3 ? !pack.naming.renameTracks : pack.naming.renameTracks,
          standardTrackFormat: namingReads < 3 ? pack.naming.standardTrackFormat : "{Track Title}",
        }),
      );
    });
    state.client = client;

    const result = await executeLidarrPresetApply({
      packRef: "builtin:balanced",
      confirm: vi.fn().mockResolvedValue(true),
    });

    expect(result.status).toBe("partial");
    expect(result.outcomes.at(-1)).toEqual(
      expect.objectContaining({
        outcome: "failed",
        attempted: false,
        error: expect.objectContaining({ code: "LIDARR_PRESET_STALE" }),
      }),
    );
    expect(client.updateNamingConfig).not.toHaveBeenCalled();
    expect(mockRunSingle.mock.calls.some(([lane]) => lane === "destructive")).toBe(false);
  });

  it("classifies a dispatched read-back mismatch as failed and does not resend", async () => {
    const client = makeNamingChangeClient();
    client.updateNamingConfig.mockResolvedValue(
      Object.freeze({ id: 1, ...structuredClone(pack.naming) }),
    );
    state.client = client;

    const result = await executeLidarrPresetApply({
      packRef: "builtin:balanced",
      confirm: vi.fn().mockResolvedValue(true),
    });

    expect(result.status).toBe("partial");
    expect(result.outcomes.at(-1)).toEqual(
      expect.objectContaining({
        outcome: "failed",
        attempted: true,
        dispatchState: "dispatched",
        error: expect.objectContaining({ code: "LIDARR_PRESET_READ_BACK_MISMATCH" }),
      }),
    );
    expect(client.updateNamingConfig).toHaveBeenCalledTimes(1);
  });

  it("classifies post-dispatch ambiguity as uncertain and releases the lock", async () => {
    const client = makeNamingChangeClient();
    client.updateNamingConfig.mockRejectedValue(new Error("connection reset"));
    state.client = client;
    const lock = await mockAcquireLock();
    mockAcquireLock.mockClear();
    mockAcquireLock.mockResolvedValue(lock);

    const result = await executeLidarrPresetApply({
      packRef: "builtin:balanced",
      confirm: vi.fn().mockResolvedValue(true),
    });

    expect(result.status).toBe("partial");
    expect(result.outcomes.at(-1)).toEqual(
      expect.objectContaining({
        outcome: "uncertain",
        attempted: true,
        dispatchState: "dispatch-unknown",
      }),
    );
    expect(client.updateNamingConfig).toHaveBeenCalledTimes(1);
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch when durable pre-dispatch intent cannot be recorded", async () => {
    const client = makeNamingChangeClient();
    state.client = client;
    const journal = {
      path: "/tmp/preset.json",
      transition: vi.fn().mockRejectedValue(new Error("disk full")),
      finalize: vi.fn().mockRejectedValue(new Error("disk full")),
    };
    mockCreateJournal.mockResolvedValue(journal);

    const result = await executeLidarrPresetApply({
      packRef: "builtin:balanced",
      confirm: vi.fn().mockResolvedValue(true),
    });

    expect(result.status).toBe("partial");
    expect(result.outcomes.at(-1)).toEqual(
      expect.objectContaining({
        outcome: "failed",
        attempted: false,
        error: expect.objectContaining({ code: "LIDARR_PRESET_JOURNAL_WRITE_FAILED" }),
      }),
    );
    expect(client.updateNamingConfig).not.toHaveBeenCalled();
  });

  it("does not report completed when final journal durability fails", async () => {
    let naming: LidarrPresetNamingConfig = Object.freeze({
      id: 1,
      ...structuredClone(pack.naming),
      renameTracks: !pack.naming.renameTracks,
    });
    const client = makeLiveClient();
    client.getNamingConfig.mockImplementation(() => Promise.resolve(naming));
    client.updateNamingConfig.mockImplementation((input) => {
      naming = Object.freeze({ ...input });
      return Promise.resolve(naming);
    });
    state.client = client;
    mockCreateJournal.mockResolvedValue({
      path: "/tmp/preset.json",
      transition: vi.fn().mockResolvedValue(undefined),
      finalize: vi.fn().mockRejectedValue(new Error("disk full")),
    });

    const result = await executeLidarrPresetApply({
      packRef: "builtin:balanced",
      confirm: vi.fn().mockResolvedValue(true),
    });

    expect(result.status).toBe("partial");
    expect(result.outcomes.at(-1)).toEqual(expect.objectContaining({ outcome: "succeeded" }));
    expect(result.error).toEqual({
      code: "LIDARR_PRESET_JOURNAL_WRITE_FAILED",
      phase: "finalize",
      resourcePath: "/tmp/preset.json",
      retryable: true,
      nextAction: "Run preset diff again, inspect the fresh state, then retry apply.",
    });
    expect(client.updateNamingConfig).toHaveBeenCalledTimes(1);
  });

  it("marks later changed resources not-attempted after an uncertain dispatch", async () => {
    const client = makeFormatAndNamingChangeClient();
    client.updateCustomFormat.mockRejectedValue(new Error("connection reset"));
    state.client = client;

    const result = await executeLidarrPresetApply({
      packRef: "builtin:balanced",
      confirm: vi.fn().mockResolvedValue(true),
    });

    expect(result.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "custom-format:rfmedia web source",
          outcome: "uncertain",
        }),
        expect.objectContaining({
          key: "naming:1",
          outcome: "not-attempted",
          blockedBy: "custom-format:rfmedia web source",
        }),
      ]),
    );
    expect(client.updateCustomFormat).toHaveBeenCalledTimes(1);
    expect(client.updateNamingConfig).not.toHaveBeenCalled();
  });

  it("aborts admissions, stabilizes the in-flight write, and releases on cleanup", async () => {
    const client = makeFormatAndNamingChangeClient();
    let cleanupPromise: Promise<void> | undefined;
    client.updateCustomFormat.mockImplementation(async (_input, signal) => {
      const cleanup = [...mockSignalHandler.cleanup.values()][0];
      expect(cleanup).toBeDefined();
      cleanupPromise = cleanup?.();
      await Promise.resolve();
      expect(signal?.aborted).toBe(true);
      throw new DOMException("Aborted", "AbortError");
    });
    state.client = client;
    const lock = await mockAcquireLock();
    mockAcquireLock.mockClear();
    mockAcquireLock.mockResolvedValue(lock);

    const result = await executeLidarrPresetApply({
      packRef: "builtin:balanced",
      confirm: vi.fn().mockResolvedValue(true),
    });
    await cleanupPromise;

    expect(result.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: "uncertain" }),
        expect.objectContaining({ key: "naming:1", outcome: "not-attempted" }),
      ]),
    );
    expect(client.updateCustomFormat).toHaveBeenCalledTimes(1);
    expect(client.updateNamingConfig).not.toHaveBeenCalled();
    expect(lock.release).toHaveBeenCalledTimes(1);
    expect(mockSignalHandler.cleanup.size).toBe(0);
  });
});
