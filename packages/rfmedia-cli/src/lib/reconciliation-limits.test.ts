import { describe, expect, it } from "vitest";

import type { DbReconciliationInventoryCandidate } from "../types/db.js";
import { MEDIA_IDENTITY_MAX_ID_BYTES, type MediaTrack } from "../types/media-server.js";
import type { ReconciliationMetadata } from "./metadata.js";
import {
  accountReconciliationLocalSnapshotBytes,
  accountReconciliationServerSnapshotBytes,
  isSafeReconciliationMp3RatingFileSize,
  MAX_RECONCILIATION_LOCAL_SNAPSHOT_BYTES,
  MAX_RECONCILIATION_MP3_RATING_FILE_BYTES,
  MAX_RECONCILIATION_PROJECTED_PATH_BYTES,
  MAX_RECONCILIATION_PROJECTED_TEXT_BYTES,
  MAX_RECONCILIATION_SERVER_SNAPSHOT_BYTES,
  MAX_RECONCILIATION_TAG_VALUES,
  validateReconciliationDatabaseProjection,
  validateReconciliationLocalProjection,
  validateReconciliationServerTrack,
} from "./reconciliation-limits.js";

const metadata: ReconciliationMetadata = {
  rating: 0.8,
  artist: "Artist",
  genre: "Rock",
  year: 2024,
};

const databaseRow: DbReconciliationInventoryCandidate = {
  id: 1,
  operation_id: 2,
  source_path: "/imports/song.mp3",
  relative_path: "song.mp3",
  mtime: 1,
  size: 2,
  rating: 0.8,
  genre: "Rock",
  year: 2024,
  bpm: null,
  artist: "Artist",
  dest_path: "/music/song.mp3",
  content_hash: null,
  copied_at: 3,
};

const serverTrack: MediaTrack = {
  id: "track-1",
  kind: "track",
  title: "Song",
  rating: 0.8,
  artist: "Artist",
  album: "Album",
  playCount: 0,
  durationMs: 180_000,
  filePath: "/music/song.mp3",
  genres: ["Rock"],
};

describe("reconciliation projection limits", () => {
  it.each([
    {
      boundary: "local metadata text",
      atLimit: () =>
        validateReconciliationLocalProjection("/music/song.mp3", {
          ...metadata,
          artist: "é".repeat(MAX_RECONCILIATION_PROJECTED_TEXT_BYTES / 2),
        }),
      overLimit: () =>
        validateReconciliationLocalProjection("/music/song.mp3", {
          ...metadata,
          artist: `${"é".repeat(MAX_RECONCILIATION_PROJECTED_TEXT_BYTES / 2)}a`,
        }),
      reason: "text-too-large",
    },
    {
      boundary: "local path",
      atLimit: () =>
        validateReconciliationLocalProjection(
          "p".repeat(MAX_RECONCILIATION_PROJECTED_PATH_BYTES),
          metadata,
        ),
      overLimit: () =>
        validateReconciliationLocalProjection(
          "p".repeat(MAX_RECONCILIATION_PROJECTED_PATH_BYTES + 1),
          metadata,
        ),
      reason: "path-too-large",
    },
    {
      boundary: "database metadata text",
      atLimit: () =>
        validateReconciliationDatabaseProjection({
          ...databaseRow,
          genre: "g".repeat(MAX_RECONCILIATION_PROJECTED_TEXT_BYTES),
        }),
      overLimit: () =>
        validateReconciliationDatabaseProjection({
          ...databaseRow,
          genre: "g".repeat(MAX_RECONCILIATION_PROJECTED_TEXT_BYTES + 1),
        }),
      reason: "text-too-large",
    },
    {
      boundary: "database path",
      atLimit: () =>
        validateReconciliationDatabaseProjection({
          ...databaseRow,
          dest_path: "p".repeat(MAX_RECONCILIATION_PROJECTED_PATH_BYTES),
        }),
      overLimit: () =>
        validateReconciliationDatabaseProjection({
          ...databaseRow,
          dest_path: "p".repeat(MAX_RECONCILIATION_PROJECTED_PATH_BYTES + 1),
        }),
      reason: "path-too-large",
    },
    {
      boundary: "server identifier",
      atLimit: () =>
        validateReconciliationServerTrack({
          ...serverTrack,
          id: "i".repeat(MEDIA_IDENTITY_MAX_ID_BYTES),
        }),
      overLimit: () =>
        validateReconciliationServerTrack({
          ...serverTrack,
          id: "i".repeat(MEDIA_IDENTITY_MAX_ID_BYTES + 1),
        }),
      reason: "identifier-too-large",
    },
    {
      boundary: "server projected text",
      atLimit: () =>
        validateReconciliationServerTrack({
          ...serverTrack,
          artist: "a".repeat(MAX_RECONCILIATION_PROJECTED_TEXT_BYTES),
        }),
      overLimit: () =>
        validateReconciliationServerTrack({
          ...serverTrack,
          artist: "a".repeat(MAX_RECONCILIATION_PROJECTED_TEXT_BYTES + 1),
        }),
      reason: "text-too-large",
    },
    {
      boundary: "server projected tags",
      atLimit: () =>
        validateReconciliationServerTrack({
          ...serverTrack,
          genres: Array.from({ length: MAX_RECONCILIATION_TAG_VALUES }, () => ""),
        }),
      overLimit: () =>
        validateReconciliationServerTrack({
          ...serverTrack,
          genres: Array.from({ length: MAX_RECONCILIATION_TAG_VALUES + 1 }, () => ""),
        }),
      reason: "too-many-tags",
    },
    {
      boundary: "aggregate local snapshot bytes",
      atLimit: () =>
        accountReconciliationLocalSnapshotBytes(MAX_RECONCILIATION_LOCAL_SNAPSHOT_BYTES - 1, 1),
      overLimit: () =>
        accountReconciliationLocalSnapshotBytes(MAX_RECONCILIATION_LOCAL_SNAPSHOT_BYTES, 1),
      reason: "snapshot-too-large",
    },
    {
      boundary: "aggregate server snapshot bytes",
      atLimit: () =>
        accountReconciliationServerSnapshotBytes(MAX_RECONCILIATION_SERVER_SNAPSHOT_BYTES - 1, 1),
      overLimit: () =>
        accountReconciliationServerSnapshotBytes(MAX_RECONCILIATION_SERVER_SNAPSHOT_BYTES, 1),
      reason: "snapshot-too-large",
    },
  ])(
    "accepts $boundary at the limit and rejects limit plus one",
    ({ atLimit, overLimit, reason }) => {
      expect(atLimit()).toMatchObject({ ok: true });
      expect(overLimit()).toEqual({ ok: false, reason });
    },
  );

  it("shares the synchronous MP3 exact-size boundary", () => {
    expect(isSafeReconciliationMp3RatingFileSize(MAX_RECONCILIATION_MP3_RATING_FILE_BYTES)).toBe(
      true,
    );
    expect(
      isSafeReconciliationMp3RatingFileSize(MAX_RECONCILIATION_MP3_RATING_FILE_BYTES + 1),
    ).toBe(false);
  });
});
