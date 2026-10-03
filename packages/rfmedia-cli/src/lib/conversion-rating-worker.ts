/**
 * Resource-limited child entry for conversion-time MP3 POPM mutation.
 *
 * File descriptor 3 is inherited from the parent's authoritative staged-file
 * handle. Opening the descriptor link retains that inode even if its pathname
 * is replaced concurrently.
 */

import NodeID3 from "node-id3";
import { fstatSync } from "node:fs";

const STAGED_FILE_DESCRIPTOR = 3;
const MAX_EMAIL_BYTES = 1024 * 1024;
const MAX_MP3_BYTES = 32 * 1024 * 1024;

export interface ConversionRatingWorkerRequest {
  readonly rating: number;
  readonly popmEmail: string;
  readonly popmCounter: number;
}

export type ConversionRatingWorkerResponse =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: "node-id3 conversion write failed" };

function stagedDescriptorPath(): string | null {
  if (process.platform === "linux") return `/proc/self/fd/${STAGED_FILE_DESCRIPTOR}`;
  if (process.platform === "darwin") return `/dev/fd/${STAGED_FILE_DESCRIPTOR}`;
  return null;
}

function isRequest(value: unknown): value is ConversionRatingWorkerRequest {
  if (typeof value !== "object" || value === null) return false;
  const { rating, popmEmail, popmCounter } = value as Record<string, unknown>;
  return (
    typeof rating === "number" &&
    Number.isFinite(rating) &&
    rating >= 0 &&
    rating <= 1 &&
    typeof popmEmail === "string" &&
    !popmEmail.includes("\0") &&
    Buffer.byteLength(popmEmail, "utf8") <= MAX_EMAIL_BYTES &&
    typeof popmCounter === "number" &&
    Number.isSafeInteger(popmCounter) &&
    popmCounter >= 0
  );
}

function writeRating(request: ConversionRatingWorkerRequest): ConversionRatingWorkerResponse {
  const descriptorPath = stagedDescriptorPath();
  if (descriptorPath === null) {
    return { ok: false, message: "node-id3 conversion write failed" };
  }
  try {
    const stats = fstatSync(STAGED_FILE_DESCRIPTOR);
    if (!stats.isFile() || stats.size > MAX_MP3_BYTES) {
      return { ok: false, message: "node-id3 conversion write failed" };
    }
  } catch {
    return { ok: false, message: "node-id3 conversion write failed" };
  }
  const popmValue = request.rating <= 0 ? 0 : Math.round(request.rating * 254) + 1;
  try {
    const result = NodeID3.update(
      {
        popularimeter: {
          email: request.popmEmail,
          rating: popmValue,
          counter: request.popmCounter,
        },
      },
      descriptorPath,
    );
    return result === true
      ? { ok: true }
      : { ok: false, message: "node-id3 conversion write failed" };
  } catch {
    return { ok: false, message: "node-id3 conversion write failed" };
  }
}

const send = process.send;
if (send === undefined) {
  process.exitCode = 1;
} else {
  process.once("message", (payload: unknown) => {
    const response: ConversionRatingWorkerResponse = isRequest(payload)
      ? writeRating(payload)
      : { ok: false, message: "node-id3 conversion write failed" };
    send.call(process, response, () => process.disconnect());
  });
}
