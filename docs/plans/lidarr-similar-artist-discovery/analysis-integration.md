# Integration Analysis: lidarr-similar-artist-discovery

## Executive Summary

Issue #203 adds two deliberately separated integrations. Read-only discovery calls one fixed
Last.fm endpoint through a new private transport and the existing `discovery` scheduler lane; it
must not resolve a Lidarr client, touch the metadata cache, or persist provider data. Optional
`--add <rank>` starts a second handoff: it resolves one MBID-backed recommendation and explicit
Lidarr policy into a sealed `rfmedia.lidarr-plan.v2` artifact, while the existing
`rfmedia lidarr apply` command remains the sole mutation entry point.

The principal integration risk is the plan/apply model, not the Last.fm GET. Existing artist plan,
history, failure, and apply-entry types assume a positive local `artistId` before dispatch.
`artist-add` instead has an expected-absent target identified by `foreignArtistId`, with a local
Lidarr ID available only after creation. Implement it as a dedicated, kind-first v2 plan family
and apply lane rather than coercing it into the current `LidarrArtistPlanEntry` path. Its POST is
non-idempotent, non-deferable, metadata-dependent work: no automatic retry or deferred-queue entry
is safe after a possibly dispatched request.

## API Endpoints

| Boundary                 | Route or command                                           | Integration contract                                                                                                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI                      | `rfmedia lidarr discover --artist <name>`                  | New leaf registered by `packages/rfmedia-cli/src/commands/lidarr.ts`; default execution is read-only.                                                                                                                                                                     |
| Last.fm                  | `GET https://ws.audioscrobbler.com/2.0/`                   | Fixed HTTPS URL with `method=artist.getSimilar`, normalized `artist`, `limit=1..100`, `autocorrect=0\|1`, `api_key`, and `format=json`. Use `redirect: "error"` and an identifiable `User-Agent`.                                                                         |
| Lidarr artist lookup     | `GET /api/v1/artist/lookup?term=lidarr:<musicbrainz-uuid>` | Resolve the selected MBID to one authoritative Lidarr artist resource. The generated operation is `getApiV1ArtistLookup`; require exactly one matching `foreignArtistId`.                                                                                                 |
| Lidarr library read      | `GET /api/v1/artist`                                       | `getApiV1Artist` backs `LidarrClientApi.listArtists()`. Use a fresh complete snapshot to detect an already-present `foreignArtistId` during planning and apply preflight. The generated endpoint also supports `mbId`, but the current facade does not expose that query. |
| Lidarr root folders      | `GET /api/v1/rootfolder`                                   | Add `getApiV1Rootfolder` behind `LidarrClientApi.listRootFolders()`. Resolve `--root-folder` by positive ID or exact normalized path; reject missing, inaccessible, or ambiguous references.                                                                              |
| Lidarr quality profiles  | `GET /api/v1/qualityprofile`                               | Existing `getApiV1Qualityprofile` and `listQualityProfiles()` resolve the required quality-profile reference by ID or exact name.                                                                                                                                         |
| Lidarr metadata profiles | `GET /api/v1/metadataprofile`                              | Existing `getApiV1Metadataprofile` and `listMetadataProfiles()` resolve the required metadata-profile reference by ID or exact name.                                                                                                                                      |
| Lidarr artist create     | `POST /api/v1/artist`                                      | Add `postApiV1Artist` behind a narrow `LidarrClientApi.addArtist()` facade. The facade obtains/retains the authoritative lookup resource privately, then overlays only the sealed root folder, profile, monitoring, and search policy.                                    |
| Apply                    | `rfmedia lidarr apply <plan-file>`                         | Existing approval, dry-run, origin, checksum, claim, history, and resume boundary. `discover --add` writes a plan only and must not accept `--yes` or call POST.                                                                                                          |

All Lidarr routes remain owned by generated code in
`packages/rfmedia-cli/src/lib/lidarr/generated/sdk.gen.ts`. Only
`packages/rfmedia-cli/src/lib/lidarr/client.ts` may import generated operations or writable DTOs;
`packages/rfmedia-cli/src/lib/lidarr/transport.ts` continues to own Lidarr origin binding,
`X-Api-Key`, redirect rejection, timeouts, response limits, and error sanitization.

The committed generated snapshot already contains `getApiV1Rootfolder`, `postApiV1Artist`,
`PostApiV1ArtistData`, `ArtistResourceWritable`, and their endpoint definitions. Extend the
required-operation, request-envelope, and endpoint assertions in
`packages/rfmedia-cli/scripts/generate-lidarr-client.mjs`,
`packages/rfmedia-cli/scripts/generate-lidarr-client.test.mjs`, and
`packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`; do not edit generated source or
refresh the OpenAPI snapshot merely to consume these existing operations.

## Database

No database migration is required. Issue #203 explicitly adds no Last.fm cache, stale fallback, or
retained raw response. In particular, do not reuse `lidarr_metadata_cache`: ordinary discovery is
one live provider request, and only the strict attributed projection may reach output or the
optional plan.

The durable stores involved in the add workflow are existing plan/apply stores:

- The plan is a bounded JSON artifact written by
  `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`, protected by the existing canonical payload
  checksum, origin binding, safe-path checks, symlink rejection, and atomic write behavior.
- Apply history remains the existing append-only JSONL store and exclusive claim directory. Add a
  dedicated history record keyed by `foreignArtistId`, with optional created `artistId`, because
  `LidarrArtistPlanHistoryRecord.artistId` cannot represent an absent pre-create target.
- Apply result and failure evidence likewise need a foreign-ID target shape; the current numeric
  `targetIds` and mandatory `artistId` fields are not sufficient before POST.
- The SQLite deferred-intent subsystem must never receive `artist-add`. Mark the operation
  non-deferable and keep it out of `createLidarrMutationExecutors()` and
  `reconcileLidarrDeferredEntries()`.

Plans may retain only minimized provenance needed to review the decision: provider and method,
requested/resolved seed, candidate rank/name/MBID/similarity/catalogue URL, discovery time, and
the explicit Lidarr policy. They must never retain the Last.fm key, Lidarr key, raw Last.fm body,
generated request objects, artwork, or arbitrary provider fields.

## External Services

**Last.fm.** `packages/rfmedia-cli/src/lib/discovery/lastfm.ts` should be the only Last.fm fetch
owner. Use Node.js 22 `fetch`, `URL`, `URLSearchParams`, `AbortSignal`, fatal UTF-8 decoding, a
1 MiB success-body cap, and a 4 KiB error-body cap; no SDK or new runtime dependency is needed.
Validate the entire response atomically before ranking. Preserve `match` as a finite value in
`[0,1]`, accept an empty MBID only as absence, require non-empty MBIDs to be canonical UUIDs, and
reject credential-bearing or off-origin catalogue URLs. Images, biographies, tags, and
streamability do not cross this boundary.

Parse Last.fm logical `{error,message}` payloads even on HTTP 200. Errors 11 and 16 and HTTP 5xx
are transient provider failures; error 29 or HTTP 429 is rate limiting; bad or suspended keys are
non-retryable configuration/authorization failures; malformed or oversized success data is
`invalid-response`. Honor only a bounded, safely parsed `Retry-After`. The API key is a required
query parameter, so no error, cause, log line, execution record, or debug output may include a full
request URL.

Successful output, including an empty recommendation set, must carry
`provider=lastfm`, `method=artist.getSimilar`, `Recommendations provided by Last.fm`,
`https://www.last.fm/`, the fetch time, and validated candidate catalogue links. The published
Last.fm terms are non-commercial absent a separate agreement and require attribution; recheck the
[method](https://www.last.fm/api/show/artist.getSimilar) and
[terms](https://www.last.fm/api/tos) immediately before release.

**Lidarr.** Discovery without `--add` has no Lidarr dependency. Add planning and apply use the
existing canonical-origin connection from `packages/rfmedia-cli/src/lib/lidarr/index.ts` and the
private generated-client facade. `foreignArtistId` is the MusicBrainz join key, but issue #203
makes no direct MusicBrainz API call. A Last.fm candidate is evidence for selection only; it must
never be copied into `ArtistResourceWritable`.

**Configuration and secret providers.** Extend `ConfigFile` in
`packages/rfmedia-cli/src/types/config.ts` with `discovery.lastfm.apiKey` and optional positive
`timeoutMs`, and validate the exact nested shape in
`packages/rfmedia-cli/src/lib/config.ts`. The existing CLI pre-action loads config, resolves
`{{ LASTFM_API_KEY }}` through `@rfmedia/common` secret injection, and then stores validated config
in `packages/rfmedia-cli/src/lib/loaded-config.ts`. Add a narrow discovery getter rather than
coupling this credential to `lidarr`. There is no `--lastfm-api-key`; dotenvx, 1Password, or the
environment owns injection. Existing recursive `apiKey` redaction helps, but the discovery command
must also redact the exact resolved key and `api_key` query values at its final failure boundary.

## Integration Points

1. **Command and presentation boundary.** Create
   `packages/rfmedia-cli/src/commands/lidarr-discover.ts` as a sibling factory similar to
   `lidarr-search.ts`, inject format/failure/execution helpers from `lidarr.ts`, and register the
   returned leaf in the documented command order. Validate artist, limit, add rank, option
   dependencies, and terminal/bidi controls before dynamically importing the action. Machine
   output uses `{command:"lidarr-discover",result}`; CSV must always emit one attributed summary
   row, even when no recommendations exist.

2. **Read-only action flow.** Add
   `packages/rfmedia-cli/src/actions/lidarr/discover.ts` and export it from
   `packages/rfmedia-cli/src/actions/lidarr/index.ts`. Normalize the seed first, then schedule one
   idempotent task in the `discovery` lane. The action owns seed removal, MBID-first first-win
   deduplication, conservative name fallback, preserved provider order, contiguous visible ranks,
   immutable projection, and execution metadata. Do not resolve any Lidarr dependency on the
   ordinary path.

3. **Scheduler seam.** `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts` currently classifies and
   retries only `instanceof LidarrError`. Replace that internal dependency with a narrow structural
   scheduled-error contract containing `code`, `retryable`, optional `statusCode`, and optional
   `retryAfterSeconds`. Add `discovery-provider-unavailable` to execution failure metadata and
   permit it to retry only for idempotent `discovery` tasks. It must not enter the Lidarr or
   metadata circuit breakers, stale-cache hints, or deferred mutation queues. Preserve the current
   discovery defaults of concurrency 4, budget 100, two additional attempts, and 30-second backoff
   cap unless validated config overrides them.

4. **Fetch ownership.** The architecture scanner in
   `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs` currently allowlists exactly the
   Plex client and Lidarr transport as production fetch owners. Add the exact Last.fm module as a
   third one-fetch owner and extend scanner fixtures. Continue rejecting provider fetches from
   commands, actions, or generic helpers.

5. **Add-plan production.** Add
   `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`. After discovery succeeds, select
   exactly one visible rank and require its MBID before resolving Lidarr. In fresh Lidarr reads,
   resolve the exact lookup identity, absence, root folder, quality profile, and metadata profile.
   If the MBID already exists, return `handoff.status="already-present"` without writing a plan.
   Otherwise write one origin-bound entry with expected absence and fixed
   `monitored=false`, `monitorNewItems="none"`, and `searchForMissingAlbums=false`.

6. **Plan model and validation.** Extend the v2 allowlist in
   `packages/rfmedia-cli/src/types/lidarr-plan.ts`,
   `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`, and
   `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`. Because existing artist
   unions, staleness findings, history, result sorting, and apply helpers require `artistId`, use a
   dedicated `artist-add` v2 subtype with a `foreign-artist-id` selection and kind-first routing,
   analogous to the repository's widened album families. Seal an exact root-folder reference,
   quality/metadata references, provenance, expected/desired state, medium non-destructive risk,
   and an idempotency key hashed from origin, operation, MBID, and policy. Keep the schema
   discriminator at `rfmedia.lidarr-plan.v2`; older binaries will reject the unknown operation.

7. **Apply preflight and dispatch.** Route `artist-add` before the existing structural artist lane
   in `packages/rfmedia-cli/src/actions/lidarr/apply.ts`. Re-resolve all referenced resources and
   perform a fresh MBID absence check. An exact existing artist with the sealed desired state is
   satisfied; an existing artist with different policy is drift and must not be edited. Dispatch
   one `idempotent:false` task in the `metadata-dependent` lane with its required health/circuit
   preflight and zero inner retries. The current apply-wide `local-only` constant is not correct
   for this operation.

8. **Ambiguous POST reconciliation.** Give artist creation a dedicated executor instead of
   `apply-artist-entry-execution.ts`, whose targeted reads require a local ID. Persist
   possible-dispatch evidence keyed by MBID before POST, then read back by MBID after either a
   response or transport ambiguity. Exact presence with the sealed postcondition is success;
   proven absence after a known pre-dispatch failure is failed; any inconclusive or mismatched
   state is uncertain. Never automatically resend or enqueue the POST. `--resume` may reconcile
   durable uncertainty, but must not replay creation blindly.

9. **Facade and resilience parity.** Extend `LidarrClientApi`, `LidarrClient`,
   `createResilientLidarrClient`, and
   `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts` together for root-folder
   reads, exact MBID read-back, and artist creation. Strictly project new root-folder and created
   artist results in `packages/rfmedia-cli/src/lib/lidarr/types.ts`; generated wire objects remain
   private.

10. **Approval and output.** Existing `lidarr apply` interactive review, `--yes`, dry-run,
    expected plan ID/checksum, exclusive claim, and origin match remain authoritative.
    `artist-add` needs no destructive authorization flag, but review and apply presenters must show
    Last.fm attribution, MBID, explicit profiles/root folder, unmonitored/no-search policy, and
    uncertainty recovery. Add Bash, Zsh, and Fish completion entries together and retain parity
    coverage in `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`.
