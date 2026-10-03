/**
 * Crash-isolated child-process entry for parsing untrusted audio metadata.
 *
 * Raw music-metadata output never crosses this boundary. Projection, resource
 * limits, safe-text classification, and artwork hashing complete in this child;
 * only one size-checked serialized snapshot is sent to the parent.
 */

import { serialize } from "node:v8";

import { parseFile } from "music-metadata";

import {
  ConversionMetadataError,
  MAX_METADATA_CHILD_IPC_BYTES,
  projectConversionMetadataForChild,
  safeConversionMetadataChildMessage,
  type ConversionMetadataChildRequest,
  type ConversionMetadataChildResponse,
} from "./conversion-metadata.js";

function sanitizedChildError(error: unknown): ConversionMetadataChildResponse {
  if (error instanceof ConversionMetadataError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: safeConversionMetadataChildMessage(error.code),
        fields: error.fields,
      },
    };
  }
  return {
    ok: false,
    error: {
      code: "metadata_parse_failed",
      message: safeConversionMetadataChildMessage("metadata_parse_failed"),
      fields: [],
    },
  };
}

function childRequest(): ConversionMetadataChildRequest {
  const filePath = process.argv[2];
  const ratingPath = process.argv[3];
  if (filePath === undefined || ratingPath === undefined) {
    throw new ConversionMetadataError("invalid_source", "Invalid child-process request");
  }
  return { filePath, ratingPath };
}

async function run(): Promise<ConversionMetadataChildResponse> {
  try {
    const request = childRequest();
    const metadata = await parseFile(request.filePath, { skipCovers: false });
    return {
      ok: true,
      snapshot: projectConversionMetadataForChild(metadata, request.ratingPath),
    };
  } catch (error) {
    return sanitizedChildError(error);
  }
}

function serializeBoundedResponse(response: ConversionMetadataChildResponse): Uint8Array {
  const payload = serialize(response);
  if (payload.byteLength <= MAX_METADATA_CHILD_IPC_BYTES) return payload;
  return serialize(
    sanitizedChildError(
      new ConversionMetadataError(
        "resource_limit",
        "Serialized metadata snapshot exceeds the IPC limit",
        ["metadata"],
      ),
    ),
  );
}

const send = process.send;
if (send === undefined) {
  process.exitCode = 1;
} else {
  const payload = serializeBoundedResponse(await run());
  await new Promise<void>((resolve) => {
    send.call(process, payload, () => resolve());
  });
  process.disconnect();
}
