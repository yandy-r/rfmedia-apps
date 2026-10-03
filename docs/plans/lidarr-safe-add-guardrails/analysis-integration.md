# Integration Analysis: Lidarr Safe Add Guardrails

## Executive Summary

Issue #206 should extend the existing checksum-sealed Lidarr artist-add plan/apply
lane, not introduce a direct add command or use the stale paths named in the issue.
The current implementation already enforces the core safe behavior:
`monitored: false`, `monitorNewItems: "none"`, and
`searchForMissingAlbums: false` in both its domain input and generated-client
facade. The remaining work is to model any explicit monitoring override in the
sealed plan, select an albums-only metadata profile without guessing, and make
optional post-add album-type normalization resumable and verifiable.

The issue's `searchForNewArtist: false` name does not exist in the pinned Lidarr
artist API. Lidarr exposes `AddArtistOptions.searchForMissingAlbums`; the separate
album-add API exposes `searchForNewAlbum`. The implementation should satisfy the
intent with `searchForMissingAlbums: false` and must not invent an unsupported
wire property or cast around the generated types.

No database migration is required for a synchronous implementation. Plans,
exclusive claims, and JSONL apply history already provide the persistence
boundary. However, normalization is a second mutation after artist creation, so
the history lifecycle must distinguish “artist created/reconciled, normalization
pending” from terminal success. A one-time empty album listing cannot guarantee
future normalization if Lidarr populates albums asynchronously.

## API Endpoints

### Existing artist-add boundary

| Operation                    | Endpoint                                       | Current integration                                                  |
| ---------------------------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| Resolve authoritative artist | `GET /api/v1/artist/lookup?term=lidarr:<mbid>` | `prepareArtistAdd` requires an exact foreign artist ID match         |
| Create artist                | `POST /api/v1/artist`                          | `addArtist` sends and verifies the safe policy                       |
| Resolve root folders         | Lidarr root-folder endpoint                    | Plan creation and apply preflight resolve stable resource references |
| Resolve quality profiles     | Lidarr quality-profile endpoint                | Plan and apply validate ID/name drift                                |
| Resolve metadata profiles    | `GET /api/v1/metadataprofile`                  | Currently projected to ID/name only                                  |

The current artist request body includes:

```text
monitored: false
monitorNewItems: "none"
addOptions.monitor: "none"
addOptions.monitored: false
addOptions.searchForMissingAlbums: false
```

Relevant code:

- `packages/rfmedia-cli/src/types/lidarr.ts`: sealed `LidarrArtistAddInput`;
  currently accepts only the safe literal values.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: public facade, strict runtime
  validation, exact lookup, POST, and response verification.
- `packages/rfmedia-cli/src/lib/lidarr/generated/types.gen.ts`: pinned generated
  `AddArtistOptions`, `ArtistResourceWritable`, album, and metadata-profile DTOs.
- `packages/rfmedia-cli/src/lib/lidarr/generated/sdk.gen.ts`: generated endpoint
  functions; keep private behind the facade.
- `packages/rfmedia-cli/openapi/lidarr-v1.manifest.json`: pinned upstream commit,
  generator version, and specification checksum.

### Required album normalization calls

| Operation                      | Endpoint                          | Required behavior                                             |
| ------------------------------ | --------------------------------- | ------------------------------------------------------------- |
| List albums for created artist | `GET /api/v1/album?artistId=<id>` | Scope by artist ID; filter album types locally                |
| Change monitoring              | `PUT /api/v1/album/monitor`       | Send sorted, unique positive album IDs and `monitored: false` |
| Verify postcondition           | `GET /api/v1/album`               | Re-read targeted IDs and require all to be unmonitored        |

The generated album list endpoint has no server-side album-type filter. Reuse
`packages/rfmedia-cli/src/lib/lidarr/album-types.ts`, which already provides the
closed selector vocabulary, parser, case-insensitive primary/secondary matching,
and OR semantics. Unknown or absent types should match nothing. Filter only
currently monitored albums, sort and deduplicate IDs, and treat an empty match as
a reported no-op.

The facade already exposes `listAlbums({ artistId })` and
`setAlbumsMonitored(ids, false)`. It validates scoped reads and caps mutation
batches at 1,000 IDs. The PUT response is generated as `unknown`, so HTTP
acceptance is not proof of success; the apply path must verify with a subsequent
read.

The codegen contract test covers these generated functions and endpoint
envelopes, but the generator script's required-operation/required-endpoint lists
do not currently fail closed on both album-list and album-monitor operations.
If the feature depends on them, add those operations to the generator contract
alongside focused generated-contract tests. Do not edit generated output or
refresh the upstream specification merely to consume already-present endpoints.

### Metadata-profile capability

The wire metadata profile includes `primaryAlbumTypes`,
`secondaryAlbumTypes`, and `releaseStatuses`; nested type entries contain an ID,
name, and `allowed` flag. The current `LidarrProfile` projection discards those
fields, preventing structural detection of an albums-only profile.

Add a separate stable facade type such as `LidarrMetadataProfile` rather than
exposing generated DTOs or expanding every generic profile consumer. Validate
nested arrays, positive IDs, bounded names, and booleans at the facade boundary.
Define an albums-only candidate structurally:

- the only allowed primary album type is `Album`;
- no secondary album type is allowed;
- release-status selections do not determine whether the profile is albums-only.

Auto-select only when exactly one live profile matches. If zero or multiple
profiles match, require an explicit metadata-profile selector and report the
ambiguity. Do not infer policy from profile names.

## Database

No relational database change is needed for the plan-first synchronous design.
The relevant persistence is file based:

- Plan JSON stores the canonical operation, resource references, selected
  entries, checksum, and expected postconditions.
- Per-plan JSONL history under the Lidarr history directory records dispatch
  evidence and terminal outcomes using atomic replacement.
- Exclusive claim files prevent competing applies for the same plan.
- Artist-add is intentionally non-deferable; the SQLite
  `lidarr_deferred_intents` table must not receive the non-idempotent POST or the
  composite add/normalize workflow.

Post-add normalization changes the durable lifecycle. The apply history should
retain enough evidence to resume after any boundary:

1. no artist POST dispatched;
2. POST may have been dispatched and requires exact foreign-ID reconciliation;
3. artist ID is known but album normalization is pending;
4. normalization mutation was attempted and requires verification;
5. artist and normalization postconditions are verified.

Prefer a backward-compatible extension to the existing artist-add history record
or a new versioned record variant. Existing exact-key parsers must continue to
accept old histories. Do not record terminal success before the requested
normalization is verified.

If the product requires eventual normalization of albums that appear later, the
current synchronous history is insufficient: that behavior requires a deliberate
durable job/deferred schema, retry policy, and ownership model. It should be
treated as separate scope rather than silently enqueueing work.

## External Services

### Lidarr behavior and limits

- Artist creation is non-idempotent. Keep exactly one POST behind durable
  possible-dispatch evidence, then reconcile by MusicBrainz artist ID; never
  blindly retry the POST.
- Album-monitor updates are idempotent, but still require bounded batches,
  verification reads, and the same cancellation/claim discipline as the add.
- Lidarr may populate album metadata asynchronously. A bounded poll can improve
  immediate reconciliation, but an empty list only proves the present state.
  Surface a pending/uncertain resumable outcome when the requested guarantee
  cannot yet be established.
- `monitored: false` and `monitorNewItems: "none"` already reduce future
  monitoring risk. Type-based normalization is an explicit belt-and-suspenders
  postcondition, especially when an override or server behavior may leave albums
  monitored.

### Configuration and secrets

The current Lidarr config contains connection settings, resilience/scheduler
controls, and quality-profile presets; it has no artist-add defaults.
`profilePresets` concern quality formats/naming and must not be repurposed for
metadata-profile selection.

Use invocation-scoped defaults for the minimal change:

- omitted monitoring option means unmonitored;
- an explicit monitoring override may change artist monitoring only;
- `monitorNewItems: "none"`, `addOptions.monitor: "none"`, and
  `searchForMissingAlbums: false` remain safe unless separately and explicitly
  designed as overrideable policies;
- metadata profile may be omitted only when a unique structural albums-only
  profile is discoverable.

If persistent add defaults are later introduced, give them an exact nested
schema, reject unknown keys, document CLI-over-config precedence, and do not
allow config to silently enable search or album monitoring. Base URL and API key
continue through the existing connection resolver and secrets injection. Plans
must store only canonical origin/resource references, never API keys.

## Integration Points

### Plan producer and CLI

The current entry point is `rfmedia lidarr discover --add <ranks>`, which hands
selected Last.fm discoveries to `plan-artist-add.ts`. It requires root folder,
quality profile, metadata profile, and plan file. There is no direct Lidarr add
leaf.

Extend this producer and its CLI flags rather than adding the issue's stale
`src/actions/lidarr/add.ts` path. If a generic artist-add producer is needed,
have it emit the same plan family and widen the currently Last.fm-specific
provenance discriminant honestly.

Any chosen override and normalization selector must be sealed into:

- the operation and each entry's expected `after` state;
- strict exact-key validation;
- canonical checksum and idempotency material;
- risk descriptions and human/JSON presenters;
- apply-time policy validation and resource preflight.

Backward compatibility requires either defaulting absent fields while reading
old v2 artifacts or introducing a compatible versioned shape. Simply making
fields optional is insufficient where validators enforce exact keys.

### Apply orchestration

The current apply path already provides approval, plan-origin validation,
cancellation, resource drift checks, exclusive claims, dry-run behavior,
possible-dispatch evidence, exact-ID reconciliation, and zero inner retries for
metadata-dependent artist adds.

Integrate normalization into that same lifecycle:

```text
read and validate plan
  -> preflight resource references
  -> reconcile artist by foreign ID
  -> create once if absent
  -> obtain authoritative artist ID
  -> list artist albums
  -> match sealed type selectors locally
  -> unmonitor matching monitored album IDs
  -> re-read and verify
  -> append terminal history only after both postconditions hold
```

On `--resume`, an already-correct artist must not be classified as fully
satisfied until the requested album normalization has also been performed or
verified. Resume should continue from the known artist ID and must never issue a
second artist POST.

### Monitoring override semantics

The safest interpretation of “unmonitored unless overridden” is:

- default artist `monitored` to `false`;
- permit only an explicit positive CLI choice to set artist `monitored: true`;
- do not infer initial album monitoring from that choice;
- preserve `monitorNewItems: "none"`, `addOptions.monitor: "none"`, and
  `searchForMissingAlbums: false`.

If broader behavior is desired, represent artist monitoring, new-album
monitoring, initial album monitoring, and missing-album search as distinct
policies. A single boolean must not implicitly enable all four.

### Primary files to change

- `packages/rfmedia-cli/src/commands/lidarr-discover.ts`: CLI inputs, validation,
  and plan handoff.
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`: metadata-profile
  default resolution and sealed policy.
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: compatible operation,
  entry, and postcondition schema.
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`: strict
  validation, risk, and idempotency behavior.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: canonicalization,
  checksums, history evolution, and parsing compatibility.
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add.ts`: composite
  lifecycle and resume orchestration.
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts`:
  create reconciliation, normalization, and terminal classification.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts` and
  `packages/rfmedia-cli/src/lib/lidarr/types.ts`: stable metadata-profile
  projection and facade validation.
- `packages/rfmedia-cli/src/lib/lidarr/album-types.ts`: reuse without duplicating
  selector semantics.
- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs`: fail-closed required
  operations/endpoints for album normalization.

### Verification targets

Extend focused tests for:

- exact safe/default and explicit-override artist POST bodies;
- rejection of unsupported `searchForNewArtist` input;
- unique, absent, and ambiguous albums-only metadata-profile resolution;
- structural metadata-profile projection and malformed-response rejection;
- sealed checksum/idempotency changes and old-plan compatibility;
- album-type matching across primary and secondary types;
- empty matches, more than 1,000 matches, PUT failure, verification mismatch,
  cancellation, and asynchronous empty-list outcomes;
- crashes before POST, after possible-dispatch, after artist reconciliation,
  after normalization PUT, and before terminal history append;
- resume without duplicate artist creation;
- dry-run performing no mutation;
- generated-client contract coverage for album list/monitor operations;
- Bash, Zsh, and Fish completion parity when CLI flags change.

Existing suites of interest include `client.test.ts`,
`plan-artist-add.test.ts`, `apply-artist-add-entry-execution.test.ts`,
`apply.test.ts`, `commands/lidarr.test.ts`, `plan-engine.test.ts`,
`plan-artist-add-operations.test.ts`, and `generated-contract.test.ts`.
