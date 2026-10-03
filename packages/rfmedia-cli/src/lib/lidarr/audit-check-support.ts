/**
 * Primitives shared by the two `rfmedia lidarr audit` evaluator modules
 * (issue #211).
 *
 * `./audit-platform-checks.js` and `./audit-library-checks.js` are split by
 * subject matter, not by capability, so both need the same slot-unwrapping
 * invariant, the same artist projection, and the same read command. Those live
 * here rather than being copied into each module: {@link requireSlotData}'s
 * message reaches an OUTPUT field (`check.detail`, via the engine's
 * `check-error` skip), so two copies could drift in a machine-consumed string.
 *
 * Deliberately free of I/O and of any import that reaches a client, an adapter,
 * or the tracking database — this module must stay as cheap to import as the
 * evaluators it serves.
 */

import type { LidarrAuditSlot, LidarrAuditSubject } from "../../types/lidarr-audit.js";
import type { LidarrArtist } from "../../types/lidarr.js";

/**
 * Read command listing artists.
 *
 * Shared by the root-folder, shared-path, and folded-name findings, all of
 * which ask the operator to compare two artist rows.
 */
export const ARTIST_LIST_COMMAND = "rfmedia lidarr list";

/**
 * Reads a hard requirement's slot, refusing to guess when it is absent.
 *
 * The engine only dispatches an evaluator once every `requires` entry is
 * available, so reaching the throw means the registry and the evaluator
 * disagree. Surfacing that as a `check-error` skip is honest; returning an
 * empty finding list would report a clean check over data that was never read.
 *
 * @param slot - The gathered slot to unwrap.
 * @param checkId - Check id, for the invariant-violation message.
 * @param requirement - Requirement name, for the invariant-violation message.
 * @returns The slot's data.
 * @throws {Error} When the slot is unavailable.
 */
export function requireSlotData<T>(
  slot: LidarrAuditSlot<T>,
  checkId: string,
  requirement: string,
): T {
  if (slot.status !== "available") {
    throw new Error(
      `audit check ${checkId} requires the ${requirement} slot, which the engine reported unavailable`,
    );
  }
  return slot.data;
}

/**
 * Projects an artist onto a finding subject.
 *
 * @param artist - The artist to describe.
 * @returns The `artist` subject.
 */
export function toArtistSubject(artist: LidarrArtist): LidarrAuditSubject {
  return { kind: "artist", artistId: artist.id, name: artist.artistName };
}
