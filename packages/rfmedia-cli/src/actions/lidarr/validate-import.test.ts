import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LidarrManualImportCandidate } from "../../types/lidarr.js";
import {
  createLidarrClientMock,
  type LidarrClientMock,
} from "../test-helpers/lidarr-client-mocks.js";

const mockResolveRequiredLidarrClient = vi.hoisted(() => vi.fn());
const mockRunSingle = vi.hoisted(() =>
  vi.fn(async (_tier: unknown, task: { run: () => Promise<unknown> }) => ({
    value: await task.run(),
    execution: {
      taskId: "lidarr-validate-import",
      operation: "lidarr validate import",
      lane: "local-only",
      outcome: "succeeded",
      attempts: 1,
    },
  })),
);

vi.mock("../../lib/lidarr/index.js", () => ({
  resolveLidarrScheduler: () => ({ runSingle: mockRunSingle }),
  resolveRequiredLidarrClient: mockResolveRequiredLidarrClient,
}));
vi.mock("../../lib/logger.js", () => ({ logDebug: vi.fn(), logInfo: vi.fn() }));

import {
  buildLidarrImportValidationFinding,
  executeLidarrValidateImport,
} from "./validate-import.js";

function candidate(
  overrides: Partial<LidarrManualImportCandidate> = {},
): LidarrManualImportCandidate {
  return {
    path: "/incoming/01.flac",
    artist: { id: 2, name: "Artist" },
    album: { id: 3, artistId: 2, title: "Album" },
    albumReleaseId: 4,
    tracks: [{ id: 5, artistId: 2, albumId: 3, title: "Track" }],
    rejections: [],
    additionalFile: false,
    replaceExistingFiles: false,
    ...overrides,
  };
}

function candidateWithMusicBrainzEvidence(
  audioTagOverrides: Partial<NonNullable<LidarrManualImportCandidate["audioTags"]>> = {},
): LidarrManualImportCandidate {
  return candidate({
    artist: { id: 2, name: "Artist", foreignArtistId: "artist-mbid" },
    album: { id: 3, artistId: 2, title: "Album", foreignAlbumId: "album-mbid" },
    albumReleaseForeignId: "release-mbid",
    tracks: [
      {
        id: 5,
        artistId: 2,
        albumId: 3,
        title: "Track",
        foreignRecordingId: "recording-mbid",
        foreignTrackId: "track-mbid",
      },
    ],
    audioTags: {
      artistMbId: "artist-mbid",
      albumMbId: "album-mbid",
      releaseMbId: "release-mbid",
      recordingMbId: "recording-mbid",
      trackMbId: "track-mbid",
      trackNumbers: [1],
      ...audioTagOverrides,
    },
  });
}

let client: LidarrClientMock;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-25T12:00:00.000Z"));
  client = createLidarrClientMock();
  mockResolveRequiredLidarrClient.mockReturnValue(client);
});

describe("Lidarr import validation", () => {
  it("classifies complete, partial, conflicting, and rejected candidates", () => {
    expect(buildLidarrImportValidationFinding(candidate()).status).toBe("ready");
    expect(
      buildLidarrImportValidationFinding(candidate({ albumReleaseId: undefined })).status,
    ).toBe("unmatched");
    expect(
      buildLidarrImportValidationFinding(
        candidate({
          tracks: [
            { id: 5, artistId: 2, albumId: 3 },
            { id: 6, artistId: 2, albumId: 3 },
          ],
        }),
      ).status,
    ).toBe("ambiguous");
    expect(
      buildLidarrImportValidationFinding(
        candidate({ rejections: [{ reason: "Release is not approved", type: "permanent" }] }),
      ),
    ).toMatchObject({ status: "rejected", reason: "Release is not approved" });
  });

  it.each([
    ["artist", { artistMbId: "different-artist-mbid" }],
    ["album", { albumMbId: "different-album-mbid" }],
    ["release", { releaseMbId: "different-release-mbid" }],
    ["recording", { recordingMbId: "different-recording-mbid" }],
    ["track", { trackMbId: "different-track-mbid" }],
  ])("classifies a parsed %s MusicBrainz ID mismatch as ambiguous", (_kind, overrides) => {
    expect(
      buildLidarrImportValidationFinding(candidateWithMusicBrainzEvidence(overrides)),
    ).toMatchObject({
      status: "ambiguous",
      reason: "Parsed MusicBrainz identifiers conflict with Lidarr's selected identities",
    });
  });

  it("compares available MusicBrainz evidence case-insensitively after normalization", () => {
    expect(
      buildLidarrImportValidationFinding(
        candidateWithMusicBrainzEvidence({
          artistMbId: " ARTIST-MBID ",
          albumMbId: " ALBUM-MBID ",
          releaseMbId: " RELEASE-MBID ",
          recordingMbId: " RECORDING-MBID ",
          trackMbId: " TRACK-MBID ",
        }),
      ),
    ).toMatchObject({
      status: "ready",
      albumReleaseForeignId: "release-mbid",
    });
  });

  it("does not treat absent selected MusicBrainz identities as conflicts", () => {
    expect(
      buildLidarrImportValidationFinding(
        candidate({
          audioTags: {
            artistMbId: "artist-mbid",
            albumMbId: "album-mbid",
            releaseMbId: "release-mbid",
            recordingMbId: "recording-mbid",
            trackMbId: "track-mbid",
            trackNumbers: [1],
          },
        }),
      ).status,
    ).toBe("ready");
  });

  it("probes once, preserves options, and sorts findings by path", async () => {
    client.probeManualImport.mockResolvedValue([
      candidate({ path: "/incoming/02.flac" }),
      candidate({ path: "/incoming/01.flac", albumReleaseId: undefined }),
    ]);

    const result = await executeLidarrValidateImport({
      folder: "/incoming",
      artistId: 2,
      filterExistingFiles: true,
      replaceExistingFiles: false,
    });

    expect(client.probeManualImport).toHaveBeenCalledOnce();
    expect(client.probeManualImport).toHaveBeenCalledWith({
      folder: "/incoming",
      artistId: 2,
      filterExistingFiles: true,
      replaceExistingFiles: false,
    });
    expect(result.report.findings.map((finding) => finding.path)).toEqual([
      "/incoming/01.flac",
      "/incoming/02.flac",
    ]);
    expect(result.report.summary).toEqual({
      total: 2,
      ready: 1,
      unmatched: 1,
      ambiguous: 0,
      rejected: 0,
      highestStatus: "unmatched",
    });
    expect(result.report.checkedAt).toBe("2026-07-25T12:00:00.000Z");
  });

  it("reports an empty probe as a successful diagnostic", async () => {
    const result = await executeLidarrValidateImport({ folder: "/incoming" });

    expect(result.report.summary).toEqual({
      total: 0,
      ready: 0,
      unmatched: 0,
      ambiguous: 0,
      rejected: 0,
      highestStatus: "ready",
    });
  });
});
