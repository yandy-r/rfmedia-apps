# Lidarr Artist Deletion API Research

## Executive Summary

The pinned Lidarr OpenAPI snapshot supports both a single-artist delete and an artist-editor
bulk delete. File-aware deletion should use `DELETE /api/v1/artist/{id}` once per resolved
target because its query parameters allow `deleteFiles` and `addImportListExclusion` to be
chosen independently for every artist. The bulk editor endpoint applies one pair of deletion
choices to the whole body and therefore cannot safely represent a mixed set of keep-files and
delete-files decisions.

The handwritten `LidarrClient` facade should expose the operation while leaving URL
construction, query serialization, authentication, timeout handling, and status mapping to the
generated SDK and hardened transport. A successful deletion has an `unknown` response schema;
the caller should treat HTTP success as completion and must not depend on a response payload.
If files were deleted, the existing Plex adapter can request a path-scoped refresh for each
captured source path and fall back to a full scan when path-to-library resolution fails.

## Primary APIs

### Single-artist delete

`DELETE /api/v1/artist/{id}` is represented by
`deleteApiV1ArtistById` in
`packages/rfmedia-cli/src/lib/lidarr/generated/sdk.gen.ts` and
`DeleteApiV1ArtistByIdData` in
`packages/rfmedia-cli/src/lib/lidarr/generated/types.gen.ts`.

| Input                    | Location | Generated type                             | Snapshot default | Use                                                                    |
| ------------------------ | -------- | ------------------------------------------ | ---------------- | ---------------------------------------------------------------------- |
| `id`                     | Path     | Required positive `number`/OpenAPI `int32` | None             | Lidarr artist identifier                                               |
| `deleteFiles`            | Query    | Optional `boolean`                         | `false`          | Select whether Lidarr also deletes the artist's files                  |
| `addImportListExclusion` | Query    | Optional `boolean`                         | `false`          | Select whether Lidarr excludes the artist from import-list re-addition |

The snapshot supplies no descriptions for the two flags beyond their names and defaults.
Implementation tests against a supported Lidarr instance should confirm filesystem and
import-list behavior before destructive end-to-end coverage relies on those interpretations.
The command should nevertheless send both booleans explicitly so behavior does not depend on a
server default changing.

The response contract is only `200: unknown`; no media type or schema is declared. Use
`parseAs: "stream"` as existing void Lidarr mutations do, discard the result through the
facade's void execution helper, and do not inspect or project a response body. The generated
runtime also tolerates an empty 200 response, but treating the payload as meaningful would
create an undocumented dependency.

```ts
import { deleteApiV1ArtistById } from "./generated/sdk.gen.js";

await this.#executeVoid(operation, signal, () =>
  deleteApiV1ArtistById({
    client: this.#generatedClient,
    path: { id: validatedArtistId },
    query: {
      deleteFiles: decision.deleteFiles,
      addImportListExclusion: decision.addImportListExclusion,
    },
    parseAs: "stream",
    signal,
  }),
);
```

### Artist-editor bulk delete

`DELETE /api/v1/artist/editor` is represented by `deleteApiV1ArtistEditor`. It accepts an
optional `ArtistEditorResource` JSON body and also returns `200: unknown`. The relevant body
fields are:

```ts
{
  artistIds: number[];
  deleteFiles: boolean;
  addImportListExclusion: boolean;
}
```

The bulk endpoint saves requests when every artist has identical deletion policy. That
advantage is outweighed for file-aware deletion by three constraints:

- `deleteFiles` and `addImportListExclusion` apply to the entire `artistIds` array, so mixed
  per-target decisions cannot be encoded.
- A single unknown success response provides no per-artist result or partial-failure detail.
- The generated type makes the body and all its properties optional, so the facade would need
  strict guards against an empty or incomplete destructive request.

Accordingly, retain the endpoint as a documented alternative but choose the single-ID endpoint
for execution. Process a bounded, unique list of positive artist IDs and record success or
failure per target. Whether execution stops at the first error or continues to collect partial
results is a product decision; it must be explicit because the API offers no transaction across
the sequence.

### Authentication and transport

The OpenAPI document declares the global `X-Api-Key` header security scheme. Callers must not
add credentials to endpoint options or query strings. `createLidarrTransport` is the sole
credential owner and:

- rejects requests outside the configured HTTP(S) origin and rejects credential-like query
  parameters or incoming sensitive headers;
- obtains the API key from `LidarrApiKeyProvider`, validates it, and injects exactly one
  `X-Api-Key` header plus `Accept: application/json`;
- disables redirects, composes caller cancellation with the configured timeout, bounds response
  bodies, and maps non-success statuses to typed Lidarr errors;
- reconstructs successful responses before the generated client parses them.

The deletion facade should therefore mirror existing mutation methods in
`packages/rfmedia-cli/src/lib/lidarr/client.ts`: validate domain input first, call the generated
function with the private generated client, and run it inside the operation-context error
boundary.

## Integration Patterns

### Per-target decision flow

Resolve and preview every target before issuing the first mutation. Preserve the Lidarr artist
ID, display identity, intended `deleteFiles` value, intended exclusion value, and any filesystem
paths needed for follow-up scans. The execution loop then calls the single-ID endpoint once for
each approved target:

```ts
for (const target of approvedTargets) {
  await lidarr.deleteArtist(target.lidarrArtistId, {
    deleteFiles: target.deleteFiles,
    addImportListExclusion: target.addImportListExclusion,
  });
}
```

This shape keeps the destructive choice attached to the target that was shown during preview.
It also permits a safe no-file-delete target and a destructive target in the same plan without
silently broadening either decision.

### Plex scan reuse

The provider-neutral `MediaServerAdapter` already declares `capabilities.scan`, advertises
`features.pathScopedScans`, and exposes:

- `scan.trigger()` for a full configured-library refresh;
- `scan.triggerPath(libraryId, scanPath)` for an explicit Plex section and path;
- `scan.triggerSource(destinationPath)` for destination-aware lookup.

`PlexAdapter` enables both scan and path-scoped scan support. `triggerSource` selects the
longest configured library-path mapping, requests a path refresh, and falls back to a full scan
if no library is configured or library lookup/path refresh setup fails. Scan operations return
`MediaServerScanResult` instead of throwing, so a failed Plex refresh should be reported as a
best-effort post-delete warning without rewriting a completed Lidarr deletion as failed.

```ts
if (target.deleteFiles && mediaServerAdapter?.capabilities.scan) {
  for (const scanPath of target.scanPaths) {
    const scanResult = await mediaServerAdapter.scan.triggerSource(scanPath);
    if (!scanResult.success) {
      logWarn(`Plex scan failed after deleting ${target.displayName}: ${scanResult.message}`);
    }
  }
}
```

Paths must be captured before deletion because Lidarr and the filesystem may no longer be able
to supply them afterward. Scan paths should be deduplicated and preferably collapsed to the
smallest safe artist/library roots to avoid redundant refreshes. Existing
`resolveOptionalScanAdapter` is the established resolver for delete-style actions and preserves
the configured optional-scan behavior.

### Constraints and safeguards

- Treat only unique positive safe-integer Lidarr IDs as valid targets and enforce the existing
  bounded plan-entry limit.
- Require an explicit reviewed `deleteFiles` boolean per target; omission must never escalate
  from metadata-only removal to filesystem deletion.
- Keep `addImportListExclusion` independently visible in preview and confirmation because it
  changes later import-list behavior even when files are retained.
- Perform all matching, ambiguity rejection, path capture, dry-run rendering, and approval
  before mutation. Do not re-resolve a target from a display name during execution.
- Use generated SDK exports but do not hand-edit generated files. Public command code should
  depend on a narrow `LidarrClientApi` method, not the generated client.
- Do not infer deletion success from the unknown body. Success is the transport's accepted HTTP
  status; failures cross the existing typed Lidarr error boundary.
- Define partial-success reporting for a multi-target run. Single-ID requests improve
  attribution but do not provide rollback or atomicity.
- Trigger Plex only for decisions that actually delete files and only after the corresponding
  Lidarr request succeeds.

### Open questions

- Does the supported Lidarr version interpret `deleteFiles: true` exactly as deleting all artist
  files and empty directories, and what remains after a partial filesystem failure?
- Does `addImportListExclusion: true` create an exclusion when the artist did not originate from
  an import list, and is repeated deletion idempotent?
- Should multi-target execution fail fast or continue and return a complete per-target outcome
  summary?
- Which pre-delete source should provide canonical scan paths, and at what directory level
  should multiple track paths be collapsed?
- Should Plex scan failures affect process exit status or remain warnings, consistent with the
  adapter's current best-effort result contract?
- How should a target that disappears or changes after preview be classified: stale plan,
  already complete, or hard failure?
