# External Research: Lidarr Quality Presets

## Executive Summary

Lidarr's current v1 API has the primitives needed to manage custom formats, quality profiles, and
the singleton naming configuration. The relevant paths and schemas in the committed OpenAPI
snapshot are unchanged in Lidarr `develop` commit
[`d4c72f8`](https://github.com/Lidarr/Lidarr/commit/d4c72f8ee93113ce82321b78c3365dbaf435f1b8),
committed 2026-07-24. The public API reference is
[Lidarr API Docs](https://lidarr.audio/docs/api/) (retrieved 2026-07-25), and the repository pins an
immutable earlier official snapshot at commit
[`3e28584`](https://github.com/Lidarr/Lidarr/blob/3e2858439ff35b372d0af00bcea1b0a357572d26/src/Lidarr.Api.V1/openapi.json).

The safest integration is a handwritten, narrow extension of `LidarrClientApi` backed by the
already-generated private SDK. Commands and actions must not import generated operations, generated
wire types, or handwritten `/api/v1/` paths. No new runtime library is required.

Preset documents should be semantic and ID-free. At runtime, resolve custom formats and qualities
from fresh server state, obtain a complete quality-profile skeleton from
`GET /api/v1/qualityprofile/schema`, and compute an explicit diff. A dry run must perform only GETs.
Apply should create/update custom formats first, refresh IDs, then write complete quality profiles,
and finally update naming. Every mutation should be followed by a fresh read that proves the
managed projection.

The most important API constraint is that a quality-profile write must include every current custom
format exactly once in `formatItems`, even formats not managed by the selected preset. The main
naming constraint is that `GET /config/naming/examples` is a preview endpoint, not a reliable
validation endpoint; authoritative validation occurs on `PUT /config/naming/{id}`.

**Confidence**: High. The endpoint subset was compared directly between the committed immutable
snapshot and the 2026-07-24 upstream OpenAPI, and behavior was checked against the corresponding
official controller and service source.

## Primary APIs

### Authentication and transport

All requests use the configured Lidarr origin and API key. Official source configures
`X-Api-Key`, `apikey`, and Bearer parsing; rfmedia must continue using only the `X-Api-Key` header so
credentials never enter URLs or logs. See
[`AuthenticationBuilderExtensions.cs`](https://github.com/Lidarr/Lidarr/blob/d4c72f8ee93113ce82321b78c3365dbaf435f1b8/src/Lidarr.Http/Authentication/AuthenticationBuilderExtensions.cs)
and
[`ApiKeyAuthenticationHandler.cs`](https://github.com/Lidarr/Lidarr/blob/d4c72f8ee93113ce82321b78c3365dbaf435f1b8/src/Lidarr.Http/Authentication/ApiKeyAuthenticationHandler.cs)
(2026-07-24 snapshot).

The existing hardened transport remains the sole owner of origin checks, API-key access, redirects,
timeouts, cancellation, response limits, pacing, and HTTP error mapping.

**Confidence**: High. Verified in official authentication source and the local transport.

### Custom formats

Official references:

- [Current API reference](https://lidarr.audio/docs/api/)
- [OpenAPI at the repository-pinned commit](https://github.com/Lidarr/Lidarr/blob/3e2858439ff35b372d0af00bcea1b0a357572d26/src/Lidarr.Api.V1/openapi.json)
- [Current controller source](https://github.com/Lidarr/Lidarr/blob/d4c72f8ee93113ce82321b78c3365dbaf435f1b8/src/Lidarr.Api.V1/CustomFormats/CustomFormatController.cs)
- [Current resource mapping](https://github.com/Lidarr/Lidarr/blob/d4c72f8ee93113ce82321b78c3365dbaf435f1b8/src/Lidarr.Api.V1/CustomFormats/CustomFormatResource.cs)

| Method | Endpoint                      | Request                            | Documented response                    | Use                           |
| ------ | ----------------------------- | ---------------------------------- | -------------------------------------- | ----------------------------- |
| GET    | `/api/v1/customformat`        | none                               | `CustomFormatResource[]`               | Complete current-state read   |
| GET    | `/api/v1/customformat/{id}`   | integer path ID                    | `CustomFormatResource`                 | Targeted verification         |
| POST   | `/api/v1/customformat`        | `CustomFormatResource`             | `CustomFormatResource`                 | Create                        |
| PUT    | `/api/v1/customformat/{id}`   | string-typed path ID plus resource | `CustomFormatResource`                 | Full-definition update        |
| DELETE | `/api/v1/customformat/{id}`   | integer path ID                    | unspecified body                       | Delete one managed format     |
| PUT    | `/api/v1/customformat/bulk`   | `CustomFormatBulkResource`         | incorrectly documented as one resource | Toggle rename inclusion only  |
| DELETE | `/api/v1/customformat/bulk`   | `CustomFormatBulkResource`         | unspecified body                       | Delete by IDs                 |
| GET    | `/api/v1/customformat/schema` | none                               | schema is unspecified in OpenAPI       | Discover supported conditions |

`CustomFormatResource` fields are:

```text
id?: int32
name?: string | null
includeCustomFormatWhenRenaming?: boolean | null
specifications?: CustomFormatSpecificationSchema[] | null
```

Each specification carries `id`, `name`, `implementation`, `implementationName`, `infoLink`,
`negate`, `required`, dynamic `fields`, and optional `presets`. A `Field` has metadata plus an
untyped `value`; therefore compile-time OpenAPI types alone cannot validate preset condition
values.

The current server's schema endpoint returns an ordered array of condition schemas. At the
2026-07-24 commit, official source contains four implementations:

| Implementation              | Relevant fields                    | Server validation            |
| --------------------------- | ---------------------------------- | ---------------------------- |
| `ReleaseTitleSpecification` | `value: string` regex              | non-empty                    |
| `ReleaseGroupSpecification` | `value: string` regex              | non-empty                    |
| `IndexerFlagSpecification`  | `value: integer`                   | defined `IndexerFlags` value |
| `SizeSpecification`         | `min: number`, `max: number` in GB | `min >= 0`, `max > min`      |

Sources:
[`CustomFormatSpecificationSchema.cs`](https://github.com/Lidarr/Lidarr/blob/d4c72f8ee93113ce82321b78c3365dbaf435f1b8/src/Lidarr.Api.V1/CustomFormats/CustomFormatSpecificationSchema.cs)
and the official
[`Specifications` directory](https://github.com/Lidarr/Lidarr/tree/d4c72f8ee93113ce82321b78c3365dbaf435f1b8/src/NzbDrone.Core/CustomFormats/Specifications).

The server requires a non-empty unique format name, at least one condition, nonblank condition
names, known implementations, and implementation-specific valid fields. These constraints are
verified in current controller source. Whether future Lidarr versions add implementations is not
part of the committed OpenAPI contract, so runtime schema discovery and an explicit supported-field
allowlist are both necessary.

**Confidence**: High for endpoints and current implementations; Medium for future condition
stability because condition payloads are deliberately dynamic and underspecified in OpenAPI.

### Quality profiles

Official references:

- [Current controller](https://github.com/Lidarr/Lidarr/blob/d4c72f8ee93113ce82321b78c3365dbaf435f1b8/src/Lidarr.Api.V1/Profiles/Quality/QualityProfileController.cs)
- [Schema controller](https://github.com/Lidarr/Lidarr/blob/d4c72f8ee93113ce82321b78c3365dbaf435f1b8/src/Lidarr.Api.V1/Profiles/Quality/QualityProfileSchemaController.cs)
- [Resource schema and mapper](https://github.com/Lidarr/Lidarr/blob/d4c72f8ee93113ce82321b78c3365dbaf435f1b8/src/Lidarr.Api.V1/Profiles/Quality/QualityProfileResource.cs)

| Method | Endpoint                        | Request                            | Documented response        |
| ------ | ------------------------------- | ---------------------------------- | -------------------------- |
| GET    | `/api/v1/qualityprofile`        | none                               | `QualityProfileResource[]` |
| GET    | `/api/v1/qualityprofile/{id}`   | integer path ID                    | `QualityProfileResource`   |
| POST   | `/api/v1/qualityprofile`        | `QualityProfileResource`           | `QualityProfileResource`   |
| PUT    | `/api/v1/qualityprofile/{id}`   | string-typed path ID plus resource | `QualityProfileResource`   |
| DELETE | `/api/v1/qualityprofile/{id}`   | integer path ID                    | unspecified body           |
| GET    | `/api/v1/qualityprofile/schema` | none                               | `QualityProfileResource`   |

`QualityProfileResource` is:

```text
id?: int32
name?: string | null
upgradeAllowed?: boolean
cutoff?: int32
items?: QualityProfileQualityItemResource[] | null
minFormatScore?: int32
cutoffFormatScore?: int32
formatItems?: ProfileFormatItemResource[] | null
```

Quality items are recursive groups or leaves: `id`, optional `name`, optional `{ id, name }`
`quality`, nested `items`, and `allowed`. A format item is `{ id?, format, name?, score }`, where
`format` is a custom-format ID.

`GET /qualityprofile/schema` is the authoritative construction template. Current source builds all
quality/group items and includes every existing custom format with score zero. The write validator
requires all current custom-format IDs and no extras in `formatItems`; it also rejects impossible
`minFormatScore` configurations. See
[`QualityProfileService.cs`](https://github.com/Lidarr/Lidarr/blob/d4c72f8ee93113ce82321b78c3365dbaf435f1b8/src/NzbDrone.Core/Profiles/Qualities/QualityProfileService.cs).

Deleting a profile can fail when artists, import lists, or root folders still reference it. Adding
a custom format causes Lidarr to add it with score zero to all profiles; deleting a custom format
removes it from every profile and resets score thresholds when no formats remain. These are verified
current implementation behaviors, not guarantees expressed by OpenAPI.

**Confidence**: High. Verified in the immutable/current OpenAPI and official controller/service
source.

### Naming configuration

Official references:

- [Current controller](https://github.com/Lidarr/Lidarr/blob/d4c72f8ee93113ce82321b78c3365dbaf435f1b8/src/Lidarr.Api.V1/Config/NamingConfigController.cs)
- [Resource and example mapping](https://github.com/Lidarr/Lidarr/blob/d4c72f8ee93113ce82321b78c3365dbaf435f1b8/src/Lidarr.Api.V1/Config/NamingExampleResource.cs)
- [Naming validation](https://github.com/Lidarr/Lidarr/blob/d4c72f8ee93113ce82321b78c3365dbaf435f1b8/src/NzbDrone.Core/Organizer/FileNameValidation.cs)

| Method | Endpoint                         | Request                                          | Documented response    |
| ------ | -------------------------------- | ------------------------------------------------ | ---------------------- |
| GET    | `/api/v1/config/naming`          | none                                             | `NamingConfigResource` |
| GET    | `/api/v1/config/naming/{id}`     | integer path ID                                  | `NamingConfigResource` |
| PUT    | `/api/v1/config/naming/{id}`     | string-typed path ID plus `NamingConfigResource` | `NamingConfigResource` |
| GET    | `/api/v1/config/naming/examples` | candidate config as query parameters             | unspecified in OpenAPI |

Persisted naming fields are `id`, `renameTracks`, `replaceIllegalCharacters`,
`colonReplacementFormat`, `standardTrackFormat`, `multiDiscTrackFormat`, and
`artistFolderFormat`. The response also contains derived legacy UI fields
`includeArtistName`, `includeAlbumTitle`, `includeQuality`, `replaceSpaces`, `separator`, and
`numberStyle`; current `ToModel` ignores those fields on write. They should not be preset inputs.

The examples endpoint actually returns a `NamingExampleResource` with `singleTrackExample`,
`multiDiscTrackExample`, `artistFolderExample`, and `albumFolderExample`, although OpenAPI types it
as `unknown`. If query `id` is zero or omitted, the controller replaces the candidate with the
saved configuration. A preview call must therefore include the saved positive ID and every
candidate persisted field, or use a facade contract verified against a running Lidarr instance.

Server validation requires both track formats to be non-empty, free of invalid path characters,
and to contain track title plus track number, or `{Original Title}`/`{Original Filename}`. Artist
folder format must be non-empty, free of invalid path characters, and contain an artist-name token.
These rules are unconditional in the current shared validator, even when `renameTracks` is false.
`colonReplacementFormat` maps to `0=Delete`, `1=Dash`, `2=SpaceDash`, `3=SpaceDashSpace`,
`4=Smart` in current
[`FileNameBuilder.cs`](https://github.com/Lidarr/Lidarr/blob/d4c72f8ee93113ce82321b78c3365dbaf435f1b8/src/NzbDrone.Core/Organizer/FileNameBuilder.cs).

**Confidence**: High for fields and PUT validation; Medium for examples-as-preflight because the
OpenAPI response is untyped and the current filename sample validator is largely a stub.

## Libraries and SDKs

### Existing generated SDK

The repository already pins `@hey-api/openapi-ts@0.93.0` and commits a full private Fetch SDK from
the immutable Lidarr snapshot. All operations needed by this feature already exist in
`generated/sdk.gen.ts`, including custom-format CRUD/schema, quality-profile CRUD/schema, and naming
GET/PUT/examples. The generated path types reproduce an upstream OpenAPI defect: PUT path IDs are
strings while GET/DELETE IDs are integers.

Hey API's current official docs confirm that its Fetch client supports a custom per-instance client
and passing that client to generated SDK functions:
[Fetch API Client](https://heyapi.dev/docs/openapi/typescript/clients/fetch) (retrieved 2026-07-25).
That matches the local architecture's per-origin `createClient({ baseUrl, fetch })` pattern.

Recommendation: extend only the handwritten facade and projection layer, add the generated
operations to the offline contract check, and do not refresh the snapshot or change generator
versions unless a separately reviewed upstream API change requires it.

**Confidence**: High. Verified in the committed generated tree, manifest, and official Hey API
documentation.

### Other SDKs

Third-party Lidarr SDKs are unnecessary. They would create a second transport/authentication/error
boundary, weaken the repository's single-Fetch-owner architecture, and still inherit the
underspecified schema/example responses. No runtime dependency is justified for JSON diffing,
preset validation, or deterministic ordering.

**Confidence**: High for the recommendation; it follows directly from the repository's existing
generated-client contract and the complete endpoint coverage already present.

## Integration Patterns

### Read, normalize, diff, apply, verify

1. Fetch custom formats, quality profiles, the quality-profile schema, and naming config through
   narrow facade methods.
2. Strictly project unknown wire data into immutable domain models. For dynamic custom-format
   fields and naming examples, validate explicit keys, value types, sizes, and control characters.
3. Resolve preset semantic names to current IDs. Reject duplicate or ambiguous names; never select
   the first match silently.
4. Canonicalize arrays for comparison without changing semantic order. Quality item/group order is
   meaningful; custom-format condition order should be preserved unless the server proves it is
   irrelevant.
5. Produce a deterministic diff. Omit server-owned IDs and derived naming fields from preset
   equality, but include them in an apply plan's resolved references.
6. For dry run, stop after reads and diff generation. Do not use POST, PUT, DELETE, or bulk
   endpoints.
7. Apply custom formats first. Re-read all custom formats so server-assigned IDs and any normalized
   fields are current.
8. Re-read `/qualityprofile/schema`, merge preset quality choices/scores into the complete current
   skeleton, and preserve unmanaged custom formats with their existing score where policy says they
   are unmanaged.
9. Update naming by overlaying managed persisted fields on a fresh saved resource.
10. After every mutation, perform a fresh targeted or collection GET and verify the exact managed
    projection. Treat an accepted mutation without converged state as uncertain, not successful.

**Confidence**: High. This pattern respects verified full-resource writes and the existing
plan/apply verification model.

### Ownership and pruning

Curated packs should be additive by default. A pack owns only resources explicitly named in its
manifest. Unmanaged custom formats and profiles must not be deleted or reset. Destructive pruning
needs a separate explicit option, plan entry per deletion, reference checks, and confirmation.

Quality-profile writes cannot simply omit unmanaged custom formats: the server rejects a
`formatItems` list that does not include all current formats. Merge unmanaged entries into the full
payload, with their current scores, even when the diff reports only preset-owned fields.

**Confidence**: High for the merge requirement; Medium for the recommended ownership policy because
it is a product-safety decision rather than a Lidarr API rule.

### Idempotency and ordering

There are no ETags, revision tokens, or documented idempotency keys on these endpoints. Use
GET-before-write, skip no-op writes, serialize dependent mutations, and verify after write. Create
operations should first resolve by exact name and fail on ambiguity to avoid duplicate resources
after an uncertain response.

OpenAPI documents only `200`, while current controllers use created/accepted response helpers.
Existing facade behavior that accepts any successful 2xx should be retained; do not couple apply
success to one status code or to a mutation response body.

**Confidence**: High for the absence of concurrency/idempotency fields in the API contract and for
the current controller response pattern.

## Constraints and Gotchas

1. **Generated privacy is mandatory.** Only `src/lib/lidarr/client.ts` may import generated
   operations/types. Commands, actions, plans, presets, and public types depend on stable
   handwritten domain contracts.
2. **PUT path ID type is wrong upstream.** OpenAPI emits `string` for custom-format,
   quality-profile, and naming PUT path IDs, but integer for GET/DELETE. Confine conversion inside
   the facade.
3. **Quality profile writes are complete replacements.** `items` and `formatItems` must be complete;
   partial PATCH semantics do not exist.
4. **Every custom format must appear in every profile.** Preserve unmanaged entries and refresh the
   schema after custom-format creation/deletion.
5. **Schema responses are partly untyped.** Custom-format schema and naming examples are `unknown`
   in generated types and need bounded handwritten validation.
6. **Dynamic condition values need allowlists.** Never replay arbitrary `Field.value` payloads from
   untrusted presets. Validate implementation, field name, type, regex length, number range, and
   duplicates.
7. **Naming preview is not validation.** It does not persist and the current sample filename
   validator returns no failure. A valid-looking example does not prove PUT will pass.
8. **Naming query fallback can hide mistakes.** Omitting/zeroing `id` makes examples use the saved
   config rather than necessarily previewing the supplied candidate.
9. **Derived naming fields are not persisted.** Ignore them as preset inputs and do not diff them as
   independently writable state.
10. **Naming validation is stricter than the rename toggle suggests.** Preserve valid standard and
    multi-disc patterns even when track renaming is disabled.
11. **Profile deletion is reference constrained.** Artists, import lists, and root folders can
    block deletion.
12. **Custom-format bulk update is narrow.** It only changes
    `includeCustomFormatWhenRenaming`; it cannot bulk-edit definitions or scores.
13. **Server-created IDs are environment-local.** Presets must use semantic names and resolve IDs
    during planning.
14. **Quality/group IDs should come from the current schema.** Do not hardcode current numeric IDs,
    especially synthetic group IDs.
15. **No documented transaction spans the three resources.** Apply must expose partial progress and
    a deterministic resume/replan path; rollback is a new forward mutation, not a transaction abort.
16. **Current and pinned contracts match, but mutable upstream can drift.** Keep offline generation
    from the committed snapshot as the default and fail contract checks if required operations or
    schemas disappear.

**Confidence**: High for API constraints 1-14 and 16; Medium for the recommended recovery policy in
15 because Lidarr does not publish transaction semantics beyond the absence of such an API.

## Code Examples

### Stable facade shape

Generated names below are implementation notes only; actions consume this narrow interface.

```ts
interface LidarrPresetClientApi {
  listCustomFormats(signal?: AbortSignal): Promise<readonly LidarrCustomFormat[]>;
  getCustomFormatSchema(signal?: AbortSignal): Promise<readonly LidarrCustomFormatSchema[]>;
  createCustomFormat(input: LidarrCustomFormatCreate, signal?: AbortSignal): Promise<LidarrCustomFormat>;
  updateCustomFormat(id: number, input: LidarrCustomFormatUpdate, signal?: AbortSignal): Promise<LidarrCustomFormat>;

  listQualityProfileDefinitions(signal?: AbortSignal): Promise<readonly LidarrQualityProfileDefinition[]>;
  getQualityProfileSchema(signal?: AbortSignal): Promise<LidarrQualityProfileDefinition>;
  createQualityProfile(
    input: LidarrQualityProfileCreate,
    signal?: AbortSignal,
  ): Promise<LidarrQualityProfileDefinition>;
  updateQualityProfile(
    id: number,
    input: LidarrQualityProfileUpdate,
    signal?: AbortSignal,
  ): Promise<LidarrQualityProfileDefinition>;

  getNamingConfig(signal?: AbortSignal): Promise<LidarrNamingConfig>;
  previewNaming(input: LidarrNamingConfig, signal?: AbortSignal): Promise<LidarrNamingExamples>;
  updateNamingConfig(id: number, input: LidarrNamingConfigUpdate, signal?: AbortSignal): Promise<LidarrNamingConfig>;
}
```

Inside `client.ts`, the implementation may call private generated operations such as
`getApiV1Customformat`, `getApiV1QualityprofileSchema`, and `putApiV1ConfigNamingById`, always with
the per-instance generated client and hardened transport.

### Quality-profile merge

```ts
function mergeFormatScores(
  completeSchema: readonly ProfileFormatItem[],
  current: readonly ProfileFormatItem[],
  presetScoresByName: ReadonlyMap<string, number>,
): readonly ProfileFormatItem[] {
  const currentScoreById = new Map(current.map((item) => [item.formatId, item.score]));

  return completeSchema.map((item) => ({
    formatId: item.formatId,
    name: item.name,
    score: presetScoresByName.get(item.name) ?? currentScoreById.get(item.formatId) ?? 0,
  }));
}
```

Before use, reject duplicate custom-format names and verify that every preset score name resolved
exactly once. This example intentionally starts from the complete server schema rather than the
preset.

### Header-authenticated diagnostic reads

```bash
curl --fail-with-body \
  --header "Accept: application/json" \
  --header "X-Api-Key: ${LIDARR_API_KEY}" \
  "http://localhost:8686/api/v1/qualityprofile/schema"

curl --fail-with-body \
  --header "Accept: application/json" \
  --header "X-Api-Key: ${LIDARR_API_KEY}" \
  "http://localhost:8686/api/v1/customformat/schema"
```

These are operator diagnostics only. Production code must use the private generated operations
through the facade and must never place the key in `apikey` query parameters.

## Open Questions

1. What exact curated packs and assumptions are in scope: lossy, lossless, high-resolution,
   bandwidth/storage constrained, or combinations? Each pack needs explicit codec/container,
   upgrade, score, and naming assumptions.
2. Does a pack own only resources it creates, or may it update same-named existing resources? The
   default should be fail-on-conflict unless users explicitly adopt existing resources.
3. Should removals ever be automatic? If yes, how is ownership recorded so an unrelated same-named
   resource cannot be deleted?
4. Is matching by exact case-sensitive name sufficient, or should presets carry a durable
   tool-owned marker? Lidarr exposes no dedicated external ID field on these resources.
5. Which custom-format condition implementations are supported initially? Current Lidarr has four,
   but the API is schema-driven and future versions may add more.
6. Should regex safety enforce only size/control-character limits, or also reject patterns with
   likely catastrophic backtracking before sending them to Lidarr?
7. How should a preset express quality groups and cutoff semantics without embedding environment
   IDs? A schema-name mapping policy and ambiguity behavior are needed.
8. Does preset equality treat the order of conditions as significant? Preserve order until this is
   proven otherwise by integration tests.
9. Should naming preview be surfaced as advisory output only, with local token validation plus PUT
   as the authoritative apply gate?
10. What partial-apply recovery UX is required when custom formats succeed but a later profile or
    naming update fails?
11. Will destructive profile/custom-format operations be excluded from the first release? Doing so
    materially reduces reference and rollback risk.
12. Against which supported Lidarr versions should live contract tests run? The committed snapshot
    is stable, but dynamic schema payloads require at least one real-instance fixture before
    declaring full compatibility.
