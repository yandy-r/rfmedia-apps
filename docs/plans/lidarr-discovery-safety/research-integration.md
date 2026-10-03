# Integration Research: Lidarr Discovery Safety

## API Endpoints

### Last.fm discovery

`packages/rfmedia-cli/src/lib/discovery/lastfm.ts` owns the only discovery-provider network call:

```text
GET https://ws.audioscrobbler.com/2.0/
  ?method=artist.getSimilar
  &artist=<seed>
  &limit=<1..100>
  &autocorrect=<0|1>
  &api_key=<application-key>
  &format=json
```

The official [`artist.getSimilar`](https://www.last.fm/api/show/artist.getSimilar) response supplies
ordered candidates with `name`, `match` (0–1 similarity), optional MusicBrainz artist ID, and a
Last.fm URL. The repository deliberately projects only those fields in
`packages/rfmedia-cli/src/types/discovery.ts`; it does not retain tags, listeners, play counts,
images, biographies, or arbitrary provider data.

The boundary performs exactly one request per `getSimilarArtists()` invocation. Multi-seed or deep
discovery therefore costs one Last.fm request per visited seed. No batch, paging, graph traversal,
or provider-side loop-prevention endpoint exists.

### Lidarr lookup and add

Discovery itself must remain independent of Lidarr. The optional add-plan handoff in
`packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts` uses the generated-independent
`LidarrClientApi` from `packages/rfmedia-cli/src/lib/lidarr/client.ts`:

| Purpose                    | Facade method            | Generated endpoint                             |
| -------------------------- | ------------------------ | ---------------------------------------------- |
| Resolve candidate identity | `lookupArtists()`        | `GET /api/v1/artist/lookup?term=lidarr:<mbid>` |
| Detect an installed artist | `getArtistByForeignId()` | `GET /api/v1/artist?mbId=<mbid>`               |
| Resolve add resources      | `listRootFolders()`      | `GET /api/v1/rootfolder`                       |
| Resolve quality policy     | `listQualityProfiles()`  | `GET /api/v1/qualityprofile`                   |
| Resolve metadata policy    | `listMetadataProfiles()` | `GET /api/v1/metadataprofile`                  |
| Create the reviewed artist | `addArtist()`            | `POST /api/v1/artist`                          |

The generated SDK and wire types remain private under
`packages/rfmedia-cli/src/lib/lidarr/generated/`. New discovery policy code must not import them or
call Lidarr directly.

`discover --add <rank>` does not call `POST /api/v1/artist`. It resolves exactly one current visible
rank, requires a canonical lowercase MBID, proves an exact unambiguous Lidarr lookup, checks current
library absence, resolves the three named resources, and writes one sealed plan. Only
`rfmedia lidarr apply` performs the POST after a fresh dry-run review and interactive approval or
explicit `--yes`.

The existing artist-add plan family in `packages/rfmedia-cli/src/types/lidarr-plan.ts` is fixed to
`maxBatch: 1` and a one-entry tuple. Consequently, `--max-add` cannot authorize a multi-entry add
without widening the sealed plan/apply contract or producing multiple independent one-entry plan
artifacts. A safety cap alone is useful for traversal, but it does not create a bulk-add capability.

## Database

The current SQLite schema is version 10 in `packages/rfmedia-cli/src/lib/schema.sql`. Its Lidarr
tables are:

- `lidarr_metadata_cache`, limited by
  `packages/rfmedia-cli/src/lib/lidarr/metadata-cache.ts` to Lidarr `artists`, `lookup`, and
  `system-status` projections;
- `lidarr_deferred_intents`, a failure-replay queue owned by
  `packages/rfmedia-cli/src/lib/lidarr/deferred-queue.ts`; and
- `lidarr_circuit_state`, persisted Lidarr/metadata circuit-breaker state.

None is a discovery approval queue. The metadata cache has no candidate lifecycle, the deferred
queue represents already-authorized mutation intent after a retryable failure, and circuit state is
unrelated. Reusing any of them for quarantine would conflate review with recovery and create unsafe
replay semantics.

No new database persistence is needed for the bounded issue-#205 implementation if “quarantine”
means the current safe workflow:

1. obtain a fresh recommendation set;
2. mark candidates in the returned document as rejected, quarantined, or eligible by pure policy;
3. promote only an explicitly selected eligible rank into a sealed plan; and
4. use the existing plan file plus apply history as durable evidence after promotion.

Rank is explicitly invocation-local in
`packages/rfmedia-cli/docs/features/lidarr-discovery.md`, so it must never be used as a durable
quarantine identity.

If the product requires `quarantine list/approve/reject` across separate invocations, expiry,
multiple operators, or rediscovery suppression across runs, new persistence is required. That
should be a dedicated schema/migration and child issue keyed by provider plus canonical MBID, with a
bounded normalized-name fallback only when no MBID exists. It must not be hidden inside issue #205's
current 3–5-file scope.

## External Services

### Last.fm

`packages/rfmedia-cli/src/lib/discovery/lastfm.ts` confines requests to a fixed HTTPS origin,
rejects redirects, validates bounded UTF-8/JSON bodies, caps success bodies at 1 MiB and error
bodies at 4 KiB, composes caller cancellation with a 15-second default timeout, and never retains a
URL, body, cause, or raw Fetch error in `LastFmProviderError`.

Provider and HTTP failures are mapped to stable contracts:

- API errors 11/16 and HTTP 5xx: `discovery-provider-unavailable`, retryable;
- API error 29 and HTTP 429: `rate-limited`, retryable, with bounded `Retry-After` metadata;
- API errors 9/13 or HTTP 401: `authentication`, not retryable;
- API errors 4/26 or HTTP 403: `authorization`, not retryable;
- API error 10: `configuration`, not retryable;
- rejected inputs, API errors 2/3/5/6/7/8, and HTTP 400/404: `validation`, not retryable;
- malformed, oversized, unknown, or unexpected responses: `invalid-response`, not retryable;
- boundary timeout: `timeout`, retryable; caller abort is propagated as cancellation.

The Last.fm API key appears in the query string by provider requirement. It must remain confined to
this module and absent from logs, errors, output, plans, caches, and visited-set identities.

The current response cannot support true popularity dampening: it has no listener/play-count input.
It also cannot measure genre or catalogue diversity because tags and other attributes are discarded.
Calling `artist.getInfo` or `artist.getTopTags` for every candidate would add a new endpoint,
response contract, request multiplication, scheduler budget, and failure policy. Issue #205 should
therefore either define diversity using available graph evidence (seed coverage, depth, duplicate
paths) and label it accurately, or defer provider-enriched popularity/diversity scoring.

### Lidarr

Lidarr has no similar-artist endpoint in the committed client snapshot. It participates only after
explicit candidate promotion.

`packages/rfmedia-cli/src/lib/lidarr/transport.ts` is the sole authenticated Lidarr Fetch owner. It
binds requests to one canonical configured origin, rejects credentials in URLs and generated
headers, injects `X-Api-Key` after validation, rejects redirects, bounds bodies, validates UTF-8,
maps HTTP failures to sanitized typed errors, and composes timeout/cancellation.

Artist lookup is metadata-dependent even though it enters through the local Lidarr API. Lookup can
fail when Lidarr's upstream metadata service is unavailable. Policy evaluation should still return
the complete Last.fm preview when the optional handoff fails, matching the current single-document
`handoff.status: "failed"` contract.

## Internal Services

The current flow is:

```text
packages/rfmedia-cli/src/commands/lidarr-discover.ts
  -> packages/rfmedia-cli/src/actions/lidarr/discover.ts
     -> packages/rfmedia-cli/src/lib/discovery/lastfm.ts
     -> discovery scheduler lane
     -> pure first-win dedupe, seed exclusion, and visible ranking
     -> optional packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts
        -> Lidarr facade and metadata-dependent scheduler lane
        -> sealed one-entry plan
        -> later reviewed packages/rfmedia-cli/src/actions/lidarr/apply.ts
```

`packages/rfmedia-cli/src/actions/lidarr/discover.ts` currently identifies candidates as:

- `mbid\0<lowercase-mbid>` when an MBID exists; or
- `lastfm-name\0<NFC-name>` otherwise.

It removes first-win duplicates, excludes the resolved seed by NFC name, preserves provider order,
and assigns new contiguous one-based ranks. The name fallback is case-sensitive and is weaker than
an MBID; deep traversal needs one shared visited set across all seeds and depths, with MBID preferred
and a deliberately documented normalized-name fallback. Visited state should include the starting
seed before traversal to prevent a back-edge from reintroducing it.

`packages/rfmedia-cli/src/lib/lidarr/scheduler.ts` is the only retry owner. Its discovery lane
defaults to concurrency 4, operation budget 100, two additional attempts, and a 30-second backoff
cap. It retries only idempotent classified transient failures. Each deep-traversal provider call
must be a separately budgeted discovery task; do not hide a whole graph walk inside one scheduler
task or implement a second retry loop.

The optional Lidarr handoff uses the `metadata-dependent` lane with retry attempts overridden to
zero during plan construction. Artist creation is non-idempotent and is never blindly retried or
deferred. `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts` writes a
durable possible-dispatch marker before POST and reconciles by exact MBID after ambiguous dispatch.

## Configuration

Existing configuration contracts are defined in
`packages/rfmedia-cli/src/types/config.ts` and validated in
`packages/rfmedia-cli/src/lib/config.ts`:

```yaml
discovery:
  lastfm:
    apiKey: "{{ LASTFM_API_KEY }}"
    timeoutMs: 15000

lidarr:
  baseUrl: "{{ LIDARR_URL }}"
  apiKey: "{{ LIDARR_API_KEY }}"
  scheduler:
    lanes:
      discovery:
        concurrency: 4
        operationBudget: 100
        retryAttempts: 2
        retryBackoffCapMs: 30000
```

`discovery.lastfm` accepts only `apiKey` and `timeoutMs`; the timeout range is 1–300,000 ms and the
key is a bounded, control-free application credential. Template expansion is eager for every
command loading the config, so an unresolved `LASTFM_API_KEY` also blocks unrelated commands.
There is no Last.fm credential flag or configurable provider URL.

Issue #205's non-secret policy defaults may be config-only or CLI-overridable, but they should live
under a provider-independent `discovery.policy` object rather than `discovery.lastfm`. Adding it
requires updating the exact-key validators in `packages/rfmedia-cli/src/lib/config.ts`, public
types in `packages/rfmedia-cli/src/types/config.ts`, and examples in `rfmedia.example.yaml`.
Thresholds must be finite bounded numbers; fanout/add/depth limits must be bounded positive safe
integers; mutually exclusive modes must fail before config, client, or scheduler resolution.

## Integration Points

1. Add a pure policy module at `packages/rfmedia-cli/src/lib/discovery/policy.ts`. It should accept
   validated candidates plus traversal evidence and return immutable policy decisions and final
   ranks. It must perform no Fetch, Lidarr resolution, prompting, persistence, or output.
2. Apply the policy in `packages/rfmedia-cli/src/actions/lidarr/discover.ts` after strict provider
   projection and before visible ranking or handoff selection. Threshold rejection must happen
   before `--max-per-seed` and the global `--max-add`/promotion cap.
3. Keep preview as the no-mutation default. “Quarantined” must not imply persisted state unless a
   dedicated persistence contract is added. Promotion should continue through the sealed
   plan/apply boundary, whose interactive prompt defaults to no and requires `--yes` for
   non-interactive or machine-output mutation.
4. Preserve one-hop discovery as the safe default. `--deep` is feasible only as explicit bounded
   breadth-first traversal. `--no-cascade` should force one hop and conflict with `--deep`; otherwise
   the two flags describe contradictory traversal policies. The issue must choose and document a
   finite maximum depth because the current provider and scheduler have no unlimited-traversal
   contract.
5. Enforce three independent bounds during traversal: provider results requested per seed, accepted
   candidates per seed, and global visited/returned/promotable candidates. `--max-add` is an
   authorization ceiling, not a fetch or traversal ceiling.
6. Preserve original Last.fm similarity as provenance. Any adjusted score must be a separate named
   field with deterministic tie-breaking; do not overwrite `similarity` or present it as confidence.
   With current inputs, valid reranking signals are limited to similarity, depth, seed/path coverage,
   and duplicate-path evidence. True popularity or tag diversity needs new provider integrations.
7. Continue returning discovery results when optional Lidarr planning fails. Policy rejection,
   missing MBID, already-present state, lookup ambiguity, and transient handoff failure need distinct
   machine-readable outcomes; only provider failure prevents the preview itself.
8. Keep issue boundaries explicit: configurable add monitoring/profile normalization belongs to
   #206; indexer/download cascade estimation belongs to #219; provider federation, enrichment, and
   response caching belong to #204. Issue #205 should prevent recommendation-loop growth without
   silently implementing those integrations.
9. Any new command flags must be added to Bash, Zsh, and Fish templates in
   `packages/rfmedia-cli/src/lib/shell-completions/` and covered by
   `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`.
