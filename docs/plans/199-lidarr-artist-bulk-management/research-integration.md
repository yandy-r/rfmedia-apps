# Integration Research — Lidarr Artist Bulk Profile and Tag Management

Issue #199 should add two sealed-plan producers and new operation definitions without creating a
second Lidarr client, mutation path, scheduler, queue, or database schema. The required endpoints
already exist in the pinned generated SDK; the work is to expose narrow validated facade methods,
extend the strict plan artifact to v2 while retaining the exact v1 reader, and reuse the existing
claim, JSONL history, deferred-intent, scheduler, transport, and resume boundaries.

## API Endpoints

All endpoint paths and methods remain owned by
`packages/rfmedia-cli/src/lib/lidarr/generated/sdk.gen.ts`. Commands, actions, selectors, and plan
definitions must call only `LidarrClientApi` methods from
`packages/rfmedia-cli/src/lib/lidarr/client.ts`; they must not import generated modules or spell
`/api/v1/` paths.

| Operation                     | Generated function        | Required facade use                                                                                                                |
| ----------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/artist`          | `getApiV1Artist`          | Fetch the complete fresh cohort for planning and the whole-plan apply preflight. Do not reuse `lidarr list` paging or stale cache. |
| `GET /api/v1/artist/{id}`     | `getApiV1ArtistById`      | Re-read one artist immediately before admission and again after an accepted write for postcondition verification.                  |
| `GET /api/v1/qualityprofile`  | `getApiV1Qualityprofile`  | Resolve quality-profile selectors and desired references to strict `{ id, name }` projections.                                     |
| `GET /api/v1/metadataprofile` | `getApiV1Metadataprofile` | Resolve metadata-profile selectors and desired references to strict `{ id, name }` projections.                                    |
| `GET /api/v1/tag`             | `getApiV1Tag`             | Resolve tag selectors and desired references to strict `{ id, label }` projections.                                                |
| `PUT /api/v1/artist/editor`   | `putApiV1ArtistEditor`    | Apply one artist's profile assignment or one explicit tag mutation per request.                                                    |

The generated snapshot models the editor as `200: unknown`, but Lidarr's controller returns
`202 Accepted` with updated artists. Treat any valid successful `2xx` as acceptance, ignore the
body, and prove success through the targeted fresh artist read. The existing transport already
uses `Response.ok`, so the facade's void execution path should remain response-body independent.

The stable facade should add intent-bearing capabilities for:

- `getArtistById(id, signal)`;
- `listQualityProfiles(signal)`, `listMetadataProfiles(signal)`, and `listTags(signal)`;
- assigning one artist's requested `qualityProfileId` and/or `metadataProfileId`;
- applying one artist tag mode: `add`, `remove`, or `replace`.

Facade projectors must reject an entire malformed response, require positive safe integer IDs and
bounded non-empty names/labels, return fresh immutable domain objects, and normalize artist tag IDs
to a unique ascending set. Profile mutation bodies must contain only `artistIds` plus at least one
requested profile field. Tag bodies must contain only `artistIds`, normalized `tags`, and explicit
`applyTags`; issue #199 maps set and clear to `replace`, with clear represented only as `tags: []`.
Monitoring, root-folder, move-files, delete-files, import-list-exclusion, search, and other editor
fields must remain unrepresentable.

## Database Schema/Storage

No database migration, schema version bump, or new table is required.

The existing schema-v10 table in `packages/rfmedia-cli/src/lib/schema.sql`,
`lidarr_deferred_intents`, is operation-generic: `operation`, `payload_json`, and
`idempotency_key` can store the new exact executor contracts without structural changes:

```text
lidarr.artist-profile-assignment
  { artistId, qualityProfileId?, metadataProfileId? }

lidarr.artist-tag-mutation
  { artistId, mode, tagIds }
```

Payload validators must use exact keys, positive IDs, normalized tag arrays, and no labels,
credentials, headers, response bodies, or prototype/sensitive keys. Clear is persisted as
`mode: "replace"` with `tagIds: []`. The existing unique constraint on
`(origin, idempotency_key)`, pending/in-progress claim transition, attempt counters, backoff, and
explicit executor map remain authoritative. `packages/rfmedia-cli/src/lib/lidarr/deferred-queue.ts`
and `deferred-queue-db.ts` need only recognize the new operation definitions through the existing
registry, not change row storage.

Plan artifacts and apply history are filesystem storage, not database rows:

- Plans default under `RFMEDIA_PLAN_DIR`, otherwise
  `~/.config/rfmedia/plans`, via `packages/rfmedia-cli/src/lib/plan.ts`.
- Per-plan history remains compacted JSONL under
  `<plan-dir>/lidarr-history/<plan-id>-<checksum>.jsonl`.
- Exclusive real-apply claims remain under `<plan-dir>/lidarr-claims/<plan-id>.lock`.
- Files retain private `0600` modes, directories `0700`, no-follow/symlink checks, atomic
  publication, exact identity checks, and the 10 MiB artifact/history limit.

`rfmedia.lidarr-plan.v2` is the only persisted schema evolution. Preserve the exact
`rfmedia.lidarr-plan.v1` parser, canonical representation, checksum, artist-monitoring semantics,
history identity, and resume behavior. All producers should write v2 after this feature, but readers
must dispatch strictly by version and never rewrite a v1 artifact because its original checksum is
part of its history identity. V2 adds canonical selection context plus discriminated monitoring,
profile-assignment, and tag-mutation entries; checksums cover the resolved IDs/labels, exact sorted
targets, before/after state, tag deltas, cap, risk, and idempotency keys.

The tracking database remains lazily opened only when real apply must reconcile or enqueue deferred
work. It continues to use the configured/default tracking database (XDG
`~/.config/rfmedia/tracking.db`, with the existing legacy fallback). Dry-run must not open storage
for writes, acquire a claim, append history, or enqueue deferred work.

## External Services

The only runtime external service is the configured Lidarr instance. Profile and tag assignment are
local Lidarr database operations and remain on the `local-only` reliability lane; they do not
require the Lidarr metadata provider health gate. A tag can still affect tag-scoped Lidarr
configuration, and profile changes affect future acquisition/album policy, so previews must report
those cascade risks without claiming current files, queue entries, monitoring, or searches change.

No new runtime SDK or dependency is needed. The repository already pins:

- Lidarr OpenAPI 3.0.4 commit
  `3e2858439ff35b372d0af00bcea1b0a357572d26`;
- snapshot SHA-256
  `4ae9e79e9662898ed4704ce80f091161587a9f0d664f9e518b11a038616e491f`;
- `@hey-api/openapi-ts@0.93.0`;
- the bundled generated Fetch runtime with generated authentication disabled.

Normal generation, checks, builds, tests, and runtime use are offline with respect to upstream
GitHub. Only the explicit
`npm run openapi:lidarr:refresh --workspace packages/rfmedia-cli -- <40-hex-commit>` workflow may
refresh the immutable snapshot.

## Internal Services

The dependency direction must remain:

```text
command -> action -> selector / plan engine -> stable LidarrClientApi
-> private generated SDK -> sole authenticated transport -> Lidarr
```

- `packages/rfmedia-cli/src/commands/lidarr.ts` owns Commander grammar, conflicts, approval,
  rendering, machine envelopes, and exit behavior. It must not resolve remote resources or mutate.
- New profile/tag plan actions under `packages/rfmedia-cli/src/actions/lidarr/` own fresh
  orchestration and artifact creation. A pure shared selector/resolver owns reference resolution,
  AND/all-of filtering, full-cohort caps, deterministic sorting, and tag set algebra.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` owns strict version dispatch,
  canonicalization, checksums, safe artifact I/O, claims, history, resume selection, and the
  allowlisted operation registry.
- Each operation definition owns entry construction, risk, change detection, live classification,
  idempotency input, minimal facade execution, postcondition verification, deferred payload
  validation, and exact replay matching.
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts` must delegate every new facade method. New
  reads may be classified as idempotent reads, but planning/apply use `retryAttemptsOverride: 0`,
  no stale fallback, and no cache-derived mutation authority. Mutations must not enter the
  decorator's in-place retry allowlist.
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts` remains the only admission/concurrency layer.
  Planning, preflight, targeted reads, writes, and verification use the `local-only` lane; no new
  command-level concurrency flag or job runner is needed.
- `packages/rfmedia-cli/src/lib/lidarr/transport.ts` remains the single production authenticated
  Fetch owner. It validates the exact canonical origin before retrieving the key, injects only
  `X-Api-Key`, rejects redirects and credential-bearing URLs/headers, composes cancellation with
  timeout, bounds bodies, and maps status failures to the Lidarr error taxonomy.

Apply must preserve per-target durability: whole-plan resource/artist preflight before any write,
mutation-free dry-run, exclusive claim for real apply, targeted late-drift check, one
`artistIds: [id]` editor request, targeted verification, then synchronous history persistence
before admitting the next artist. Initial drift blocks all writes; late drift, lost claim,
cancellation after dispatch, failed reconciliation, or remote success followed by history failure
stops later admissions. Resume skips durable `succeeded`/`satisfied` entries and replays only an
exact operation, payload, and idempotency-key match.

## Configuration

Issue #199 needs no new persistent configuration keys. Continue resolving:

- `lidarr.baseUrl`, `lidarr.apiKey`, and optional `lidarr.timeoutMs`;
- `lidarr.resilience.*` for breaker, read retry, cache, and deferred-attempt policy;
- `lidarr.scheduler.lanes.local-only.*` for concurrency, operation budget, retry count, and backoff;
- CLI `--lidarr-url` / `--lidarr-api-key` overrides through the existing resolver;
- `RFMEDIA_PLAN_DIR` as the plan/history/claim test and operations seam.

The connection resolver canonicalizes the base URL to an HTTP(S) origin and rejects credentials,
paths, queries, and fragments. The plan stores only that credential-free origin. API keys should
continue to come from configuration templates/environment, dotenvx, or 1Password; they must never
enter plans, history, deferred rows, logs, errors, or machine output.

The current `local-only` scheduler defaults are concurrency 8, operation budget 1,000, one
additional retry, and a 15-second retry cap. Do not add feature-specific scheduler settings.
The plan cap remains the narrower user safety boundary: default 25, hard maximum 1,000, with the
complete cohort resolved before the cap check and no truncation.

## Integration Points

1. Extend stable public projections in `packages/rfmedia-cli/src/types/lidarr.ts` and strict
   projectors in `packages/rfmedia-cli/src/lib/lidarr/types.ts`; keep generated DTOs private.
2. Extend `LidarrClientApi`, `LidarrClient`, and the resilience decorator together. Facade tests
   should assert exact generated method/path/body behavior, `202` acceptance, ignored bodies,
   aborts, malformed resources, and absence of unrelated editor fields.
3. Add strict v2 types and version-dispatched read/write/checksum logic in
   `packages/rfmedia-cli/src/types/lidarr-plan.ts` and
   `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`, while keeping v1 bytes and behavior
   immutable.
4. Register only `lidarr.artist-profile-assignment` and `lidarr.artist-tag-mutation` executors.
   Reuse the schema-v10 deferred table and JSONL history unchanged; explicitly test that no
   migration is introduced.
5. Generalize `packages/rfmedia-cli/src/actions/lidarr/apply.ts` around operation-owned resource
   preflight, classification, targeted verification, and richer before/after/observed results.
   Retain one-artist execution and exact resume reconciliation.
6. Update `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs` so the snapshot contract
   requires `getApiV1ArtistById`, `getApiV1Qualityprofile`, `getApiV1Metadataprofile`,
   `getApiV1Tag`, and `putApiV1ArtistEditor` in addition to the existing required operations.
   Keep `codegen:lidarr:check` offline and non-mutating.
7. Extend `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs` and its fixtures to preserve
   the existing generated-import, generated-re-export, handwritten-path, and exactly-one-Fetch
   rules, plus reject direct editor mutation call sites outside the facade/registered operation
   boundary.
8. Validate with the focused facade, plan-engine, apply, deferred-queue, command, and architecture
   tests plus:

   ```bash
   npm run codegen:lidarr:check --workspace packages/rfmedia-cli
   npm run test:codegen:lidarr --workspace packages/rfmedia-cli
   npm run check:architecture --workspace packages/rfmedia-cli
   npm run test:architecture --workspace packages/rfmedia-cli
   npm run typecheck --workspace packages/rfmedia-cli
   npm run test:run --workspace packages/rfmedia-cli
   npm run build --workspace packages/rfmedia-cli
   ```

The principal integration gotcha is the editor acceptance/verification gap: neither a generated
`unknown` response body nor a `202` alone proves the artist reached the reviewed state. Durable
`succeeded` must mean the fresh targeted read established the operation-specific postcondition;
otherwise the outcome remains reconcilable or uncertain and later admissions stop.
