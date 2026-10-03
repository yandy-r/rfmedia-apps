# Pattern & Code Analysis: lidarr-safe-add-guardrails

## Executive Summary

The current repository already has a safety-focused artist-add implementation, but it is an
optional `lidarr discover --add` handoff into a sealed artist-add plan, not the standalone
`src/actions/lidarr/add.ts` flow anticipated by issue #206. Artist creation is currently hard-wired
to `monitored: false`, `monitorNewItems: "none"`, and the current Lidarr API field
`searchForMissingAlbums: false` at every layer from public types through the POST body and
reconciliation. The feature should extend that existing plan/apply lane, preserve the handwritten
client facade and exact-plan validation boundaries, and reuse the shipped album-type vocabulary and
album-monitoring machinery rather than introducing a second unmonitored-album implementation.

## Implementation Patterns

- **Plan first, mutate only at apply**: `executeLidarrArtistAddPlan()` performs fresh exact-MBID and
  shared-resource reads, seals reviewed intent into a checksummed artifact, and never calls
  `addArtist()` — `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`.
- **Policy is part of immutable desired state**: add policy is repeated in the operation, every
  entry's `after` state, the idempotency-key material, and the checksum-protected plan. Any new
  monitored/search/post-add setting must be sealed through all of those representations rather than
  read from mutable config at apply time — `packages/rfmedia-cli/src/types/lidarr-plan.ts`,
  `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`,
  `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`.
- **Exact-key, fail-closed artifact parsing**: v2 plans reject unknown keys, mismatched selection and
  operation kinds, policy drift, duplicate targets, reordered ranks, and checksum changes. Adding
  policy fields requires coordinated changes to the operation/entry types, builders,
  `requireExactKeys()` validators, canonicalization, risk calculation, and deterministic tests —
  `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`.
- **Foreign-ID add is a dedicated non-idempotent lane**: artist creation is keyed by canonical
  lowercase MusicBrainz ID and routed before the numeric artist/album mutation registry. It is
  explicitly non-deferable because a lost POST response cannot be blindly replayed —
  `packages/rfmedia-cli/src/actions/lidarr/apply.ts`,
  `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add.ts`.
- **Durable marker before non-idempotent dispatch**: apply prepares authoritative identity, acquires
  the claim, writes `possibly-dispatched` history, sends one POST, then reconciles by exact MBID.
  Ambiguous outcomes stop later admissions and resume reconciles without resending the POST —
  `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts`.
- **Fresh desired-state classification**: an installed artist is satisfied only when identity,
  monitored state, new-item monitoring, quality profile, metadata profile, and normalized root path
  match the sealed entry. Otherwise apply blocks as stale rather than silently normalizing unrelated
  state — `classifyLidarrArtistAddTargetState()` in
  `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts`.
- **Generated client stays private**: actions depend on `LidarrClientApi`; only
  `packages/rfmedia-cli/src/lib/lidarr/client.ts` imports the generated SDK/types, and only
  `transport.ts` owns authenticated `fetch`. New wire fields or profile projections belong in the
  facade boundary, not commands/actions — enforced by
  `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`.
- **Strict unknown-to-domain projection**: facade responses are bounded, validated, freshly copied,
  and frozen. A malformed collection rejects the whole response rather than leaking generated DTOs
  upward — `packages/rfmedia-cli/src/lib/lidarr/types.ts`.
- **Resolve references by authoritative ID plus review label**: planning accepts exact ID or name
  references, resolves them against fresh root/profile lists, and seals both ID and label/path so
  apply can detect deletion or rename drift — `packages/rfmedia-cli/src/lib/lidarr/artist-selection.ts`,
  `packages/rfmedia-cli/src/actions/lidarr/apply-resources.ts`.
- **Closed album-type vocabulary**: post-add type selection should reuse
  `LIDARR_ALBUM_TYPE_SELECTORS`, singular aliases, canonical sorting, and OR matching across primary
  and secondary types. Unknown future Lidarr types deliberately match nothing —
  `packages/rfmedia-cli/src/lib/lidarr/album-types.ts`.
- **Changes-only album monitoring**: existing album monitoring scans an explicit artist scope,
  filters by canonical selectors, excludes albums already in the desired state, enforces entry and
  batch caps, and seals scan/match accounting before `setAlbumsMonitored()` is allowed —
  `packages/rfmedia-cli/src/actions/lidarr/plan-albums.ts`,
  `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`.
- **Commands parse; actions decide; presenters render**: Commander leaves validate grammar before
  lazy action imports, actions never render, machine output goes to stdout, and human output goes to
  stderr — `packages/rfmedia-cli/src/commands/lidarr-discover.ts`,
  `packages/rfmedia-cli/src/commands/lidarr.ts`,
  `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`.

## Existing Code Structure

### Current artist-add path

1. `packages/rfmedia-cli/src/commands/lidarr-discover.ts` exposes `--add <ranks>` and currently
   requires `--root-folder`, `--quality-profile`, `--metadata-profile`, and `--plan-file`.
2. `packages/rfmedia-cli/src/actions/lidarr/discover.ts` approves visible ranks, then dynamically
   imports `executeLidarrArtistAddPlan()`.
3. `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts` validates provenance before
   dependency resolution, batches fresh metadata-lane reads, resolves shared resources once, omits
   already-present exact MBIDs, and writes at most one ordered plan.
4. `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` and
   `plan-operation-definitions.ts` canonicalize and checksum the artist-add operation and entries.
5. `packages/rfmedia-cli/src/actions/lidarr/apply.ts` detects artist-add by operation kind and routes
   to the specialized apply orchestrator.
6. `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add.ts` owns plan history, fresh resource
   preflight, admission stopping, dry-run, resume selection, and aggregate results.
7. `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts` is the sole production
   owner allowed to call `client.addArtist()`.
8. `packages/rfmedia-cli/src/lib/lidarr/client.ts` validates the narrow input, performs an
   authoritative exact lookup in `prepareArtistAdd()`, builds the minimal generated POST body, and
   validates the created artist projection.

### Current safe defaults

- `LidarrArtistAddInput`, `LidarrArtistAddOperationV2`, and each artist-add entry currently use
  literal types: `monitored: false`, `monitorNewItems: "none"`, and
  `searchForMissingAlbums: false`.
- The plan builder, operation definition, apply-entry dispatch, facade validator, and POST serializer
  reassert those literals instead of trusting callers.
- The current committed OpenAPI snapshot defines `AddArtistOptions.searchForMissingAlbums`; it does
  not define `searchForNewArtist`. The issue's named field is therefore stale, while its semantic
  requirement (no search on artist add) is already implemented under the current API name.
- An explicit monitored override would require intentionally widening the literal `false` across the
  public input, plan operation, entry postcondition, validator, idempotency material, POST body,
  response verification, live-state classifier, risk/presenter text, fixtures, and tests. Changing
  only the CLI/action would still be rejected by lower layers.

### Metadata profiles

- `listMetadataProfiles()` currently returns the shared `LidarrProfile` projection containing only
  `id` and `name`.
- The generated `MetadataProfileResource` also contains `primaryAlbumTypes`,
  `secondaryAlbumTypes`, and `releaseStatuses`, with per-item `allowed` flags, but those fields are
  intentionally not exposed through the current domain projection.
- A structural "albums-only" default therefore needs a dedicated generated-independent metadata
  profile projection (or a focused facade method) with strict bounded validation. It should not infer
  safety from a profile name such as `Standard`.
- Deterministic resolution should use an explicit override first; otherwise choose a structurally
  albums-only profile only when exactly one is available. Zero matches should retain the existing
  explicit-profile requirement, and multiple matches should fail as ambiguous rather than silently
  choose by list order.

### Post-add album-type normalization

- The necessary low-level capabilities already exist: `listAlbums({ artistId })`,
  `setAlbumsMonitored(albumIds, false)`, projected `albumType`/`secondaryTypes`, the closed selector
  parser, and the sealed `album-monitoring` plan lane.
- A separate operator-reviewed album-monitoring plan after add is the smallest composition of
  existing contracts.
- If post-add normalization must be one artist-add intent, its canonical selectors and desired
  unmonitored state must be sealed into the artist-add artifact and checksum. Apply must use the
  created/reconciled Lidarr artist ID to scope album reads; it must never scan the complete library.
- Integrated normalization needs its own durable stage/outcome. The current entry becomes terminal
  after artist reconciliation, so performing normalization after a recorded success would make
  `--resume` skip unfinished guardrail work. Record enough stage evidence to resume normalization
  without resending the artist POST.

## Code Conventions

- TypeScript modules use ESM `.js` import suffixes, readonly interfaces, discriminated unions,
  `Object.freeze()`, and `satisfies` for exact domain shapes.
- Inputs are validated before resolving config/client dependencies where possible; terminal control
  characters, unbounded strings, invalid IDs, duplicate selectors, and ambiguous identity all fail
  before transport or artifact writes.
- Resource and selector normalization is deterministic (trimmed references, lowercase canonical
  MBIDs, sorted selectors/IDs), because ordering contributes to checksums and idempotency keys.
- Lidarr work is assigned to scheduler tiers. Artist planning/creation uses
  `metadata-dependent`; exact local album monitoring uses `local-only`; apply suppresses blind retry
  for non-idempotent creation.
- Errors use the Lidarr taxonomy and redact untrusted response bodies/secrets. Action-level plan
  failures use `LidarrPlanValidationError`; facade validation uses `LidarrValidationError`; apply
  emits structured failure stage, dispatch state, verification state, retryability, and safe next
  action.
- Partial planning artifacts are forbidden. A failed/aborted/skipped read, ambiguous lookup, missing
  resource, or exceeded budget results in no file.
- Tests use Vitest, a complete typed `createLidarrClientMock()` seam, and frozen fixture builders in
  `packages/rfmedia-cli/src/actions/test-helpers/`. Widening `LidarrClientApi` requires updating the
  complete mock builder.
- Contract tests assert exact serialized bodies, exact option sets, exact command ordering, unknown
  key rejection, stable checksums/idempotency keys, and absence of transport calls on invalid input.

## Integration Points

- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`: accept resolved add policy/defaults,
  choose the metadata profile when omitted, and seal optional post-add selectors.
- `packages/rfmedia-cli/src/actions/lidarr/discover.ts`: carry new handoff policy fields from the
  command to the existing artist-add producer.
- `packages/rfmedia-cli/src/commands/lidarr-discover.ts`: current public add surface; update grammar,
  option conflicts/default behavior, and action mapping here unless a deliberate new standalone
  `lidarr add` command is designed.
- `packages/rfmedia-cli/src/commands/lidarr.ts`: register any genuinely new leaf in the documented,
  test-pinned order; the issue's proposed monolithic command file does not reflect the current split.
- `packages/rfmedia-cli/src/types/lidarr.ts`: widen the narrow add input only for intentionally
  supported overrides and add a generated-independent metadata-profile-policy projection if
  structural albums-only detection is required.
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: persist every configurable safety choice and any
  post-add selector intent as reviewed desired state.
- `packages/rfmedia-cli/src/lib/lidarr/types.ts`: validate/copy metadata profile album-type fields
  without exposing generated DTOs.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: translate the domain policy to the current
  `AddArtistOptions` wire shape and preserve exact minimal-body/response validation.
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`: canonicalize policy, include it
  in idempotency material/risk/resources, and keep artist add non-deferable.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: update exact-key parsing, entry postconditions,
  checksum validation, and round-trip compatibility.
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts`: preserve sole add
  mutation ownership; integrate post-add stages here or through a narrowly owned helper with updated
  architecture allowlists.
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add.ts`: include normalization outcomes in
  admission, resume, summaries, and partial/uncertain status.
- `packages/rfmedia-cli/src/lib/lidarr/album-types.ts`: reuse the canonical post-add selector
  vocabulary and matching semantics.
- `packages/rfmedia-cli/src/actions/lidarr/plan-albums.ts`: reference implementation for scoped
  scan/match/change accounting and batch bounds.
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`,
  `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`, and
  `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`: manually mirror every command/flag/value
  change.

## Test Pattern and Coverage Map

- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.test.ts`: validate default and override
  resolution before I/O, shared-resource reads, no partial artifacts, already-present handling,
  metadata-profile ambiguity/fallback, and sealed post-add selectors.
- `packages/rfmedia-cli/src/lib/lidarr/plan-artist-add-operations.test.ts`: lock exact operation and
  entry shapes, canonical ordering, checksum/idempotency changes, unknown-key rejection, and
  round-trip compatibility.
- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`: assert the exact POST JSON for defaults and
  overrides, no unknown `searchForNewArtist` field against the current schema, structural metadata
  profile projection, validation before transport, and response mismatch rejection.
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.test.ts`: preserve
  satisfied/drifted classification, marker-before-POST ordering, lost-response reconciliation,
  cancellation, claim/history failures, and add tests for normalization success, failure, empty/not
  yet populated albums, and resume without a second POST.
- `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`: cover multi-entry admission stopping,
  partial summaries, durable resume, and interaction with existing album-monitoring calls.
- `packages/rfmedia-cli/src/lib/lidarr/album-types.test.ts` and
  `packages/rfmedia-cli/src/actions/lidarr/plan-albums.test.ts`: reuse existing primary/secondary
  selector and changes-only semantics as the post-add contract.
- `packages/rfmedia-cli/src/commands/lidarr.test.ts`: test Commander defaults, explicit overrides,
  conflicts, pre-import validation, action argument mapping, human/machine rendering, and command
  hierarchy order.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: update exact Bash/Zsh/Fish
  command and option sets, argument-taking/file/value completion, operation scoping, and the
  no-config/no-client/no-network side-effect assertions.
- `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`,
  `packages/rfmedia-cli/scripts/generate-lidarr-client.test.mjs`, and
  `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs`: preserve generated endpoint
  coverage, private generated imports, sole Fetch ownership, handwritten API-path prohibition, and
  mutation-owner restrictions.

## Gotchas and Warnings

- **Stale issue terminology**: the committed Lidarr v1 snapshot exposes
  `searchForMissingAlbums`, not `searchForNewArtist`. Do not add an untyped extra wire property or a
  handwritten request solely to match the old name; preserve the semantic search-disabled contract
  through the generated current field.
- **Stale issue paths**: `src/actions/lidarr/add.ts` and `src/lib/lidarr/add-options.ts` do not exist.
  Artist add now spans discover handoff, sealed plan types/engine, specialized apply, and the client
  facade. A parallel inline add action would bypass review/history/reconciliation guarantees.
- **Default versus fixed policy**: unmonitored is currently not merely a default; it is a literal
  invariant. Supporting an override is a plan schema and apply semantics change, not a one-line CLI
  default.
- **Artist monitoring is not album monitoring**: `monitored`, `monitorNewItems`, and
  `addOptions.monitor` express related but distinct Lidarr behavior. Define the exact desired album
  state for an explicit monitored override and test the serialized body rather than assuming one
  flag controls all three.
- **Profile name is not policy**: `Standard` is review text, not proof of albums-only behavior.
  Inspect allowed primary/secondary album types structurally and fail closed on malformed or
  ambiguous profiles.
- **"Where available" needs deterministic fallback**: silently choosing the first metadata profile
  makes list order part of behavior and checksum generation. Prefer unique structural match,
  otherwise require an explicit reference.
- **Post-add is not atomically successful with POST**: the artist can exist while album
  normalization fails or albums have not populated yet. Report that state explicitly and retain a
  resume path that never repeats the non-idempotent create.
- **Already-present targets are currently no-ops**: planning removes them from the artifact. Decide
  explicitly whether post-add normalization applies only to newly created artists; mutating an
  already-present artist would change the existing no-op contract.
- **Album metadata may be delayed**: an empty immediate `listAlbums({ artistId })` is not proof that
  no guardrail work exists. Any retry/polling must be bounded, scheduler-accounted, cancellable, and
  represented honestly in results/history.
- **Plan schema compatibility**: adding required keys under the same v2 version causes old artifacts
  to fail exact-key validation unless the validator/canonicalizer deliberately handles both shapes.
  Choose and test the compatibility rule before changing the persisted structure.
- **Completion templates are handwritten and exact-set tested**: Bash, Zsh, and Fish must change
  together. The tests also ensure completion generation does not load config, construct a client, or
  access the network.
- **Architecture ownership is enforced**: direct generated imports, handwritten `/api/v1/` strings,
  new Fetch sites, and `addArtist()` calls outside the dedicated apply owner fail repository
  architecture tests.

## Relevant Docs

- GitHub issue #206: `https://github.com/yandy-r/rfmedia-apps/issues/206`
- `packages/rfmedia-cli/openapi/lidarr-v1.json`: authoritative committed wire contract.
- `packages/rfmedia-cli/docs/features/lidarr-discovery.md`: current discovery-to-add-plan behavior.
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`: sealed mutation, apply, resume, and album-monitoring contracts.
- `research/rfmedia-lidarr-integration/report.md`: original safe-default and album-type motivation;
  treat its endpoint/field notes as research context rather than current repository truth.
