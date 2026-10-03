## Executive Summary

Lidarr already exposes the complete wire surface needed for issue #199:

- `GET /api/v1/artist` returns the artists and their quality profile, metadata
  profile, and tag IDs.
- `GET /api/v1/qualityprofile`, `GET /api/v1/metadataprofile`, and
  `GET /api/v1/tag` resolve user-facing names to IDs.
- `PUT /api/v1/artist/editor` accepts artist IDs plus optional
  `qualityProfileId`, `metadataProfileId`, `tags`, and `applyTags`.

These contracts are present in the repository's pinned Lidarr OpenAPI snapshot
and its generated TypeScript SDK. No new third-party SDK or handwritten endpoint
path is needed. The safest integration is to extend the private `LidarrClient`
facade with narrow profile/tag reads and editor mutations, then add new operation
definitions to the existing sealed plan/apply workflow.

**Confidence**: High — the pinned OpenAPI document, generated client, Lidarr
controller source, Lidarr frontend, and Lidarr integration test agree on the
request contract. The official source is linked below.

The most important contract defect is response-related. The OpenAPI document
declares only `200` with an unknown body for the editor operation, while the
controller returns `202 Accepted` with updated artist resources. The feature
must therefore treat any valid successful `2xx` as mutation acceptance and
verify the result through a fresh `GET /api/v1/artist`; it must not depend on the
generated editor response type.

**Confidence**: High — Lidarr's
[`ArtistEditorController`](https://github.com/Lidarr/Lidarr/blob/3e2858439ff35b372d0af00bcea1b0a357572d26/src/Lidarr.Api.V1/Artist/ArtistEditorController.cs)
returns `Accepted(resources)`, while the
[pinned OpenAPI document](https://github.com/Lidarr/Lidarr/blob/3e2858439ff35b372d0af00bcea1b0a357572d26/src/Lidarr.Api.V1/openapi.json)
declares `200`. The controller behavior was last changed on 2024-08-26 and was
verified unchanged on Lidarr `develop` on 2026-07-23.

## Primary APIs

### Lidarr API

- **Provider**: Lidarr
- **Official documentation**:
  [rendered API reference](https://lidarr.audio/docs/api/) and
  [OpenAPI source](https://github.com/Lidarr/Lidarr/blob/develop/src/Lidarr.Api.V1/openapi.json)
- **Pinned project contract**:
  [commit `3e2858439ff35b372d0af00bcea1b0a357572d26`](https://github.com/Lidarr/Lidarr/commit/3e2858439ff35b372d0af00bcea1b0a357572d26),
  dated 2025-10-20
- **Authentication**: API key in `X-Api-Key`; the server also accepts
  `apikey` in the query string and Bearer syntax, but this project should keep
  header-only authentication.
- **Rate limits**: No formal API quota or rate-limit headers are declared in the
  official OpenAPI document, and no Lidarr HTTP rate-limiter was found in the
  official source. Continue using the repository's scheduler, batch cap, timeout,
  and retry classification rather than assuming unlimited capacity.
- **Pricing**: Self-hosted, GPL-3.0 software; there is no per-request API price.
  See the [Lidarr repository and license](https://github.com/Lidarr/Lidarr).

**Confidence**: High for authentication and licensing — confirmed by the
[OpenAPI security schemes](https://github.com/Lidarr/Lidarr/blob/3e2858439ff35b372d0af00bcea1b0a357572d26/src/Lidarr.Api.V1/openapi.json),
the
[`ApiKeyAuthenticationHandler`](https://github.com/Lidarr/Lidarr/blob/3e2858439ff35b372d0af00bcea1b0a357572d26/src/Lidarr.Http/Authentication/ApiKeyAuthenticationHandler.cs),
and the repository license. **Confidence**: Medium for the absence of rate
limits — this is an absence-of-documentation/source finding, not a guarantee
that every deployment or reverse proxy is unthrottled.

### Relevant Endpoints

| Method and path                 | Purpose for issue #199                                         | Pinned response contract                                           |
| ------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| `GET /api/v1/artist`            | Read the full selection universe and current profile/tag state | `ArtistResource[]`                                                 |
| `PUT /api/v1/artist/editor`     | Apply profile or tag changes to selected artist IDs            | OpenAPI: `200 unknown`; implementation: `202` with updated artists |
| `GET /api/v1/qualityprofile`    | Resolve quality profile names/IDs and validate targets         | `QualityProfileResource[]`                                         |
| `GET /api/v1/metadataprofile`   | Resolve metadata profile names/IDs and validate targets        | `MetadataProfileResource[]`                                        |
| `GET /api/v1/tag`               | Resolve tag labels/IDs                                         | `TagResource[]`                                                    |
| `POST /api/v1/tag`              | Explicitly create a tag when that behavior is in scope         | `TagResource` in OpenAPI                                           |
| `GET /api/v1/tag/detail[/{id}]` | Inspect artist and other configuration references to tags      | `TagDetailsResource[]` or one resource                             |

The official [API reference](https://lidarr.audio/docs/api/) lists all of these
operations. The checked-in OpenAPI snapshot also generated the exact project
functions `getApiV1Artist`, `putApiV1ArtistEditor`,
`getApiV1Qualityprofile`, `getApiV1Metadataprofile`, `getApiV1Tag`,
`postApiV1Tag`, and `getApiV1TagDetail`.

**Confidence**: High — official API description plus generated local contracts.

`GET /api/v1/artist` has only one server-side query parameter, `mbId`. It does
not offer general profile, tag, name, monitoring, or statistics filters.
Issue #199 selection must therefore fetch artists once and filter the bounded
domain projections locally.

**Confidence**: High — the
[official OpenAPI artist operation](https://github.com/Lidarr/Lidarr/blob/3e2858439ff35b372d0af00bcea1b0a357572d26/src/Lidarr.Api.V1/openapi.json)
declares only `mbId`.

### Artist Editor Request Semantics

The official
[`ArtistEditorResource`](https://github.com/Lidarr/Lidarr/blob/3e2858439ff35b372d0af00bcea1b0a357572d26/src/Lidarr.Api.V1/Artist/ArtistEditorResource.cs)
contains:

```text
artistIds: int[]
monitored?: boolean
monitorNewItems?: enum
qualityProfileId?: int
metadataProfileId?: int
rootFolderPath?: string
tags?: int[]
applyTags: add | remove | replace
moveFiles: boolean
deleteFiles: boolean
addImportListExclusion: boolean
```

The controller applies fields independently:

- A profile changes only when its nullable ID is present.
- Tag logic runs only when `tags` is non-null.
- `add` unions tag IDs into each artist's set.
- `remove` removes those IDs.
- `replace` replaces the entire artist tag set.
- Root-folder movement and deletion are separate branches and are not reached
  by a profile/tag-only `PUT` payload.

See the
[`ArtistEditorController`](https://github.com/Lidarr/Lidarr/blob/3e2858439ff35b372d0af00bcea1b0a357572d26/src/Lidarr.Api.V1/Artist/ArtistEditorController.cs)
and [`ApplyTags`](https://github.com/Lidarr/Lidarr/blob/3e2858439ff35b372d0af00bcea1b0a357572d26/src/Lidarr.Api.V1/ApplyTags.cs).

**Confidence**: High — direct controller implementation.

Lidarr's own UI sends the same minimal payload shape: selected `artistIds` plus
only changed profile fields, or `artistIds`, `tags`, and `applyTags`. Its tag
editor offers exactly `add`, `remove`, and `replace`.

**Confidence**: High — official
[`EditArtistModalContent`](https://github.com/Lidarr/Lidarr/blob/3e2858439ff35b372d0af00bcea1b0a357572d26/frontend/src/Artist/Index/Select/Edit/EditArtistModalContent.tsx),
[`TagsModalContent`](https://github.com/Lidarr/Lidarr/blob/3e2858439ff35b372d0af00bcea1b0a357572d26/frontend/src/Artist/Index/Select/Tags/TagsModalContent.tsx),
and
[`artistActions`](https://github.com/Lidarr/Lidarr/blob/3e2858439ff35b372d0af00bcea1b0a357572d26/frontend/src/Store/Actions/artistActions.js).

The editor validates that quality and metadata profile IDs exist before updating
the database. Its official integration test updates two artists with one editor
request and checks that both received the desired quality profile.

**Confidence**: High — official
[`ArtistEditorValidator`](https://github.com/Lidarr/Lidarr/blob/3e2858439ff35b372d0af00bcea1b0a357572d26/src/Lidarr.Api.V1/Artist/ArtistEditorValidator.cs)
and
[`ArtistEditorFixture`](https://github.com/Lidarr/Lidarr/blob/3e2858439ff35b372d0af00bcea1b0a357572d26/src/NzbDrone.Integration.Test/ApiTests/ArtistEditorFixture.cs).

### Profile and Tag Contracts

`QualityProfileResource` exposes an integer `id`, nullable `name`, upgrade and
cutoff settings, quality items, and custom-format scoring fields.
`MetadataProfileResource` exposes an integer `id`, nullable `name`, primary and
secondary album types, and release statuses. For this feature, only validated
positive `id` and non-empty `name` projections are required; editing profile
definitions is out of scope.

**Confidence**: High — official
[OpenAPI schemas](https://github.com/Lidarr/Lidarr/blob/3e2858439ff35b372d0af00bcea1b0a357572d26/src/Lidarr.Api.V1/openapi.json).

`TagResource` contains `id` and `label`. Lidarr lowercases labels when creating
or updating tags, returns an existing tag rather than inserting a duplicate
label, and refuses to delete a tag while it is in use. `TagDetailsResource`
includes `artistIds` as well as references from delay profiles, import lists,
notifications, restrictions, indexers, download clients, and auto-tagging.

**Confidence**: High — official
[`TagService`](https://github.com/Lidarr/Lidarr/blob/3e2858439ff35b372d0af00bcea1b0a357572d26/src/NzbDrone.Core/Tags/TagService.cs)
and
[`TagController`](https://github.com/Lidarr/Lidarr/blob/3e2858439ff35b372d0af00bcea1b0a357572d26/src/Lidarr.Api.V1/Tags/TagController.cs).

## Libraries and SDKs

### Existing Generated Lidarr SDK

The repository already pins:

- Lidarr OpenAPI commit
  `3e2858439ff35b372d0af00bcea1b0a357572d26`;
- OpenAPI 3.0.4 snapshot SHA-256
  `4ae9e79e9662898ed4704ce80f091161587a9f0d664f9e518b11a038616e491f`;
- `@hey-api/openapi-ts` `0.93.0`;
- a bundled Fetch client;
- flat generated operations with generated authentication disabled.

The OpenAPI blob on `develop` was still identical to the pinned blob on
2026-07-23, so the profile/tag/editor contracts have not drifted since the
2025-10-20 snapshot.

**Confidence**: High — checked-in manifest plus the official current
[OpenAPI source](https://github.com/Lidarr/Lidarr/blob/develop/src/Lidarr.Api.V1/openapi.json).

Use the generated operations already present under the private Lidarr client.
Do not import generated modules into action or command layers. No additional
runtime SDK is warranted.

**Confidence**: High — all required operations and models are already generated.

### `@hey-api/openapi-ts`

The project should remain on its exact pinned generator for this feature.
Hey API explicitly recommends exact version pinning and treating generated
output as a dependency that should not be edited manually. See the official
[`@hey-api/openapi-ts` repository](https://github.com/hey-api/openapi-ts) and
the
[`0.93.0` source tag](https://github.com/hey-api/openapi-ts/tree/%40hey-api%2Fopenapi-ts%400.93.0).

**Confidence**: High — official project documentation and the local lock/manifest
contract. The current Hey API documentation is newer than `0.93.0`, so the
checked-in generated code remains the authority for exact call signatures.

## Integration Patterns

### 1. Read, Resolve, Select, Plan, Apply, Verify

Use this sequence:

1. Read artists, profiles, and tags through narrow facade methods.
2. Resolve a profile/tag name to exactly one server ID. Accept an explicit ID as
   an alternative, but verify it exists.
3. Filter artists locally, sort them deterministically by ID, reject zero
   matches, duplicate criteria, and any result above the artifact-bound
   `maxBatch`.
4. Build a plan containing every target's expected-before and desired-after
   profile/tag state. Planning and global `--dry-run` make no mutation request.
5. At apply time, re-read current artist state and fail closed on unexpected
   drift.
6. Invoke `PUT /api/v1/artist/editor` only through the private facade and
   scheduler.
7. Re-read the artist and verify the desired profile/tag state instead of
   trusting the editor response body.

**Confidence**: High — this combines the official endpoint behavior with the
existing repository's implemented plan/apply contract.

### 2. Preserve Per-Target Safety

The Lidarr endpoint accepts many artist IDs, but the current plan engine persists
one authoritative terminal outcome per target before admitting later work. The
least risky first implementation is therefore one `artistIds: [id]` editor call
per admitted plan entry. It still uses Lidarr's bulk editor endpoint while
preserving exact stale checks, idempotency keys, durable history, deferred retry,
and resume behavior.

Only introduce multi-ID request chunks if the plan engine first gains a
well-tested batch outcome contract that can represent an uncertain response
without falsely recording every member as succeeded.

**Confidence**: High for compatibility with the existing plan engine; Medium
for the recommendation because bounded multi-ID batching could be added safely
with additional engine work.

### 3. Model Tag Operations as Desired Sets

Store sorted unique tag ID arrays in both `before` and `after`:

- `add`: `after = union(before, requestedTags)`
- `remove`: `after = before - requestedTags`
- `replace`: `after = requestedTags`

Persisting the full desired set makes dry-run summaries, stale checks, resume,
and post-write verification deterministic. The wire request may still use the
operator's chosen `add`, `remove`, or `replace` mode.

**Confidence**: High — Lidarr internally stores a set and implements these three
operations exactly as set transformations.

### 4. Treat New-Tag Creation as a Separate Explicit Mutation

Do not silently create a missing tag during read-only selection or planning.
If tag creation is included, model it as an explicit reviewed operation, re-fetch
the tag list after creation, then apply the returned/resolved ID to artists.
Creating a tag and applying it are distinct remote state changes with different
staleness and resume behavior.

**Confidence**: Medium — this is a safety recommendation derived from the
official tag and plan/apply contracts.

### 5. Dry-Run Before/After Summary

For every artist, render at least:

- artist ID and display name;
- current and desired quality profile names/IDs;
- current and desired metadata profile names/IDs;
- added, removed, and retained tag labels/IDs;
- whether the entry is changed or already satisfied.

The summary should also include requested, matched, changed, unchanged, and
rejected counts; the exact filters; `maxBatch`; operation risk; and the canonical
Lidarr origin. Resolve display names during planning, but bind the artifact and
checksum to stable numeric IDs and exact state.

**Confidence**: High — fits the established deterministic artifact boundary and
avoids label-renaming ambiguity.

## Constraints and Gotchas

1. **The OpenAPI editor response is wrong.** The generated response type is
   `unknown` for `200`, while the controller returns `202` and artist resources.
   Accept successful `2xx`, discard the untrusted body, and verify with a read.
   **Confidence**: High.

2. **Most generated fields are optional.** `ArtistEditorResource`,
   `QualityProfileResource`, `MetadataProfileResource`, and `TagResource` have
   no OpenAPI-required property list. Retain focused runtime projectors for
   positive integer IDs, non-empty names/labels, and artist state.
   **Confidence**: High.

3. **Omitted, null, and empty are materially different.** Omitted/null
   `qualityProfileId` or `metadataProfileId` means no change. `tags: []` with
   `replace` clears all tags, while an empty add/remove is a no-op. Always send
   an explicit `applyTags` value when sending tags.
   **Confidence**: High.

4. **Tag order is not semantic.** Lidarr stores artist tags in a `HashSet<int>`.
   Sort and deduplicate for artifacts, comparisons, and output.
   **Confidence**: High.

5. **No general server-side artist filters exist.** Filter locally after one
   bounded list read. Tag targeting can use each artist's `tags`; tag-detail
   endpoints are useful for reference inspection but are not required for basic
   selection.
   **Confidence**: High.

6. **Profile IDs are instance-local.** Persist IDs and the canonical Lidarr
   origin; do not assume matching names imply matching IDs across instances.
   Re-resolve and validate on the target instance during planning.
   **Confidence**: High.

7. **Tag labels are normalized by Lidarr.** Creation/update lowercases labels.
   Display the server-returned label and use server IDs in plans.
   **Confidence**: High.

8. **Tags can have broader effects.** Tag details expose use by artists and
   multiple configuration types. Applying a tag to an artist may therefore
   connect that artist to tag-scoped behavior. Include this in the risk summary;
   tag deletion and tag-definition renaming should remain out of scope.
   **Confidence**: Medium — the cross-references are explicit, while the exact
   operational effect depends on the user's configuration.

9. **Metadata profile changes have future library implications.** The profile
   contains allowed primary/secondary album types and release statuses. A change
   is a local database edit, but later refreshes can observe a different album
   selection policy. State this in the plan's cascade summary.
   **Confidence**: Medium — schema contents are authoritative; later-refresh
   impact is an inference from their purpose.

10. **There is no documented server dry-run or idempotency-key parameter.**
    Preview must remain client-side. Profile assignment and deterministic tag set
    operations are safe to re-check after uncertain results, but retries must
    continue through the existing idempotent deferred-intent workflow.
    **Confidence**: High for the missing API facilities; Medium for operational
    behavior across every Lidarr deployment.

11. **No server maximum `artistIds` length is documented.** Preserve the
    repository's conservative default batch cap and hard maximum of 1,000 rather
    than deriving a larger limit from the API.
    **Confidence**: Medium.

12. **API `info.version` is not the Lidarr application version.** The document
    reports `1.0.0`; the latest official stable release observed on 2026-07-23
    was
    [`3.1.0.4875`, published 2025-11-16](https://github.com/Lidarr/Lidarr/releases/tag/v3.1.0.4875).
    Use `GET /api/v1/system/status` for runtime version diagnostics and contract
    tests against supported instances.
    **Confidence**: High.

⚠️ **Freshness Note**: The pinned OpenAPI snapshot is dated 2025-10-20, but its
Git blob was verified unchanged on Lidarr `develop` on 2026-07-23. The editor
controller file is older (last changed 2024-08-26) but was also verified
unchanged on current `develop`.

## Code Examples

### Read Profiles and Tags Through the Generated Client

```ts
const [qualityResult, metadataResult, tagResult] = await Promise.all([
  getApiV1Qualityprofile({ client }),
  getApiV1Metadataprofile({ client }),
  getApiV1Tag({ client }),
]);

// Project unknown generated result data into narrow, frozen domain records.
```

### Minimal Editor Payloads

```ts
await putApiV1ArtistEditor({
  client,
  body: {
    artistIds: [42],
    qualityProfileId: 3,
    metadataProfileId: 2,
  },
});

await putApiV1ArtistEditor({
  client,
  body: {
    artistIds: [42],
    tags: [7, 9],
    applyTags: "add",
  },
});
```

Do not include `rootFolderPath`, `moveFiles`, `deleteFiles`, or
`addImportListExclusion` in issue #199 profile/tag payloads.

### Direct API Diagnostic

```bash
curl --fail-with-body \
  -H "X-Api-Key: ${LIDARR_API_KEY}" \
  "http://localhost:8686/api/v1/qualityprofile"

curl --fail-with-body \
  -H "X-Api-Key: ${LIDARR_API_KEY}" \
  "http://localhost:8686/api/v1/metadataprofile"

curl --fail-with-body \
  -H "X-Api-Key: ${LIDARR_API_KEY}" \
  "http://localhost:8686/api/v1/tag"
```

Never place the key in the `apikey` query parameter even though Lidarr supports
it; query credentials are more likely to appear in logs and histories.

### Deterministic Tag Preview

```ts
const before = [...artist.tags].sort((a, b) => a - b);
const requested = [...new Set(requestedTagIds)].sort((a, b) => a - b);

const after =
  mode === "replace"
    ? requested
    : mode === "add"
      ? [...new Set([...before, ...requested])].sort((a, b) => a - b)
      : before.filter((id) => !requested.includes(id));
```

## Open Questions

1. Should quality profile, metadata profile, and tag changes be separate plan
   operation kinds, or may one reviewed operation combine them? Separate kinds
   simplify risk, drift, and resume behavior; a combined command is more
   convenient.
2. Are tag arguments existing-only by default, with a separate `tag create`
   command, or should an explicit `--create-missing-tag` plan two mutations?
3. Which client-side filters are in the first release beyond exact IDs and
   include/exclude tags: name pattern, monitored state, current profile, missing
   tracks, or statistics thresholds?
4. Should tag selection mean “has any requested tag” or “has all requested
   tags”? Both need explicit CLI grammar and artifact representation.
5. Is one artist per editor request acceptable for the initial safe
   implementation, or must the plan engine gain durable multi-target batch
   outcomes before release?
6. What minimum Lidarr application version will be supported? The API version
   field cannot answer this; compatibility should be tested against the actual
   supported instance matrix.
7. Should apply perform an immediate post-write read for every target, or may a
   bounded batch share one complete artist-list refresh? Per-target reads are
   simpler and safer; a shared refresh is more efficient but complicates
   uncertain outcomes.
