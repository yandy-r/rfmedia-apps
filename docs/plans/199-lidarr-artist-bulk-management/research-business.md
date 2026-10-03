# Business Research — Lidarr Artist Bulk Profile and Tag Management

## Executive Summary

Issue #199 should expose bulk artist administration as a reviewed desired-state workflow, not as an
unbounded direct editor command. Operators need to select artists by exact IDs or explicit filters,
resolve quality profiles, metadata profiles, and tags against the target Lidarr instance, inspect
the complete before/after result, and then use the shipped `lidarr apply` safety boundary. The
recommended product model has two operation families: one profile assignment operation that may set
quality and metadata profiles together, and one tag operation with explicit `add`, `remove`, or
exact `set` semantics.

The checked-in generated client already contains Lidarr's artist-editor, quality-profile,
metadata-profile, and tag operations. The current upstream artist-editor controller validates both
profile IDs, implements tag `Add`, `Remove`, and `Replace`, persists artists with `UpdateMany`, and
returns `202 Accepted`. It does not explicitly enqueue a search, refresh, file move, deletion, or
retag command when only profile or tag fields are supplied. These are therefore local,
non-file-destructive mutations, but profile changes carry meaningful future acquisition risk:
quality profiles affect future download/upgrade choices, while metadata profiles affect which album
types Lidarr considers for an artist.

The safest interpretation of "bulk" is bulk selection and one reviewed plan, while execution
continues to use one artist ID per editor request. That preserves the existing per-target stale
check, durable outcome, retry, resume, and uncertain-state guarantees. A multi-ID HTTP request is an
optimization only after the implementation can prove per-target response coverage and crash-safe
history for the entire batch.

## User Stories

- As a Lidarr operator, I can assign a quality profile to every artist matching explicit filters
  without editing each artist in the web UI.
- As a Lidarr operator, I can change a metadata profile across a selected cohort and see which album
  policy each artist will move from and to before anything changes.
- As a Lidarr operator, I can add a tag without disturbing existing tags, remove a tag without
  disturbing unrelated tags, or intentionally replace the complete tag set.
- As a cautious operator, I must explicitly select a cohort or opt into the entire library; omitting
  selection cannot silently target every artist.
- As a reviewer, I can see the resolved target instance, selector summary, artist count, no-op
  count, profile names and IDs, and per-artist before/after values in a sealed plan.
- As an automation author, I can use stable JSON, YAML, or CSV output to distinguish matched,
  changed, unchanged, would-apply, satisfied, failed, deferred, uncertain, and skipped targets.
- As an operator, I can run `lidarr apply --dry-run` immediately before execution to revalidate the
  saved plan without mutating Lidarr or writing apply history.
- As an operator recovering from an interruption or transient Lidarr failure, I can explicitly
  resume a plan without replaying durable successes or already-satisfied targets.
- As a security-conscious operator, no API key or generated wire response is stored in the plan,
  apply history, deferred intent, log, or machine-output envelope.
- As a maintainer, I can add profile and tag operation definitions without letting commands import
  generated types, hard-code `/api/v1/` paths, or bypass the scheduler and plan/apply engine.

## Business Rules

### Artist selection

1. Planning must fetch a fresh complete artist list. Stale-cache fallback is appropriate for
   read-only `lidarr list`, but must not authorize or define mutation targets.
2. Selection requires at least one explicit selector (`--ids` or a filter) or an explicit
   whole-library switch such as `--all`. `--all` is exclusive with other selectors so its blast
   radius remains visually obvious.
3. All active filters use AND semantics. Existing behavior already defines repeated tag filters as
   "artist contains every requested tag"; profile, monitoring, and future metadata-profile filters
   should narrow that same set.
4. `--monitored` and `--unmonitored` remain mutually exclusive. A quality-profile filter and a
   metadata-profile filter may coexist because they select the intersection.
5. Exact IDs are unique positive Lidarr artist IDs. Duplicate or unknown IDs fail planning instead
   of being silently deduplicated or omitted.
6. If exact IDs and filters are allowed together, IDs define the candidate universe and every
   filter narrows it. The preview must report IDs excluded by filters. An alternative is to make
   exact-ID and filter modes mutually exclusive; this is an open command-surface decision.
7. Mutation selection must not inherit `lidarr list`'s default `limit: 50`, `offset`, or display
   paging. The complete matched set is resolved first, then checked against `maxBatch`; exceeding
   the cap fails rather than truncating the cohort.
8. The current plan bounds remain the default business contract: default `maxBatch` 25, hard
   maximum 1,000, and at most 1,000 entries. A user may deliberately raise the cap, but cannot
   bypass the hard bound.
9. Zero matches fail with a selector summary and no plan artifact. A non-empty selection in which
   every target is already at the desired state is valid and produces an all-no-op plan.
10. Selected artists are canonicalized by ascending artist ID. The exact cohort is frozen in the
    plan; filters are not rerun at apply time to add or remove artists.
11. Selection tags are evaluated from the pre-mutation snapshot. It is valid to select artists with
    tag `managed` and then remove or replace that tag; doing so does not shrink the frozen plan
    during execution.

### Profile resolution and assignment

1. Quality-profile and metadata-profile references must resolve through fresh lists from the target
   Lidarr instance before artist selection is sealed.
2. User-facing references should accept either a positive numeric ID or an exact profile name.
   Pure positive integers resolve as IDs; names are trimmed and matched case-insensitively but never
   fuzzily. No match or more than one normalized name match is fatal.
3. The plan stores the resolved numeric ID as authority and the resolved display name as review
   context. A later rename does not redirect the plan to a different ID.
4. A profile operation requires at least one desired field. Supplying both quality and metadata
   profiles should be allowed and treated as one desired-state mutation per artist, because the
   editor endpoint can update both in one request.
5. Unspecified profile fields are unmanaged: they remain absent from the editor request and changes
   to them do not create stale-state conflicts.
6. For each managed field, current state at apply may equal either the reviewed before value or the
   desired value. All desired means `satisfied`; any value outside those two states means drift;
   otherwise the entry is still safely executable. This permits harmless partial convergence when
   one of two requested profile changes happened independently.
7. A referenced profile that is deleted before apply blocks the plan before any write. Profile name
   changes may be reported as context, but the stable ID remains authoritative.
8. This feature assigns existing profiles; it does not create, modify, or delete profile resources.
9. The current editor validator requires valid positive profile IDs. A metadata profile of `None`
   or clearing the profile is not represented by the current API contract and must not be simulated
   with `0`, `null`, or an omitted field.

### Tag resolution and mutation

1. Tag references follow the same ID-or-exact-name resolution rule as profiles. Every requested tag
   must already exist on the target instance; artist tagging must not implicitly create tags.
2. Requested tag IDs are normalized to a unique ascending set before plan construction.
3. Exactly one tag mode is required:
   - `add`: desired tags are the union of the artist's current tags and requested tags.
   - `remove`: desired tags are current tags minus requested tags.
   - `set`: desired tags are exactly the requested tags and all other tags are removed.

4. `add` and `remove` require at least one tag. Clearing every tag is intentionally expressed by a
   separate, explicit `clear` choice that maps to editor `applyTags: "replace"` with `tags: []`;
   it must not happen because a variadic tag option happened to be empty.
5. `add` is satisfied when all requested tags are present, and `remove` is satisfied when none are
   present. Unrelated concurrent tag changes do not block these delta operations because the
   editor's `add` and `remove` modes preserve unrelated tags.
6. `set` is satisfied only when the complete normalized current set equals the desired set. If the
   current set is neither the reviewed before set nor the desired set, apply blocks as stale because
   `replace` would overwrite a concurrent tag edit.
7. Adding an already-present tag or removing an absent tag is a per-artist no-op. No-op entries
   remain in the plan and later become `satisfied`; they are not sent to the editor.
8. Tag label changes after planning do not change tag identity. A deleted referenced tag blocks
   apply before writes.
9. The request must always send an explicit `applyTags`; relying on the server enum's default
   (`Add`) makes malformed or incomplete requests ambiguous.

### Conflicts and no-ops

1. Tag `add`, `remove`, `set`, and `clear` modes conflict with one another.
2. `clear` conflicts with supplied tag values. `set` with an empty value list is rejected in favor
   of the explicit `clear` intent.
3. At least one desired quality or metadata profile is required for a profile operation.
4. Profile assignment and tag mutation should remain distinct operation kinds and distinct plan
   artifacts. Combining them creates harder rollback, stale-comparison, and partial-failure
   semantics without adding essential value.
5. A desired profile may also be a selection filter. The resulting all-no-op plan is valid and
   should plainly report zero changes rather than fail as a user error.
6. An artist missing between selection and plan construction, or a duplicate target produced by
   selector composition, fails planning. No implicit last-write-wins behavior is permitted.

### Plan, dry-run, and apply safety

1. Planning is read-only and preview-first. It resolves resources and artists, computes exact
   before/after state, counts changed and unchanged entries, renders the full bounded review, and
   writes a checksum-sealed, secret-free artifact without calling a mutation endpoint.
2. Profile previews show `quality: name (id) -> name (id)` and/or
   `metadata: name (id) -> name (id)`. Tag previews show complete before/after sets plus the
   operation delta. Aggregate summaries include selected, changed, unchanged, and transitions
   grouped by source and destination profile or tag delta.
3. The artifact remains bound to a canonical Lidarr origin, operation allowlist, exact targets,
   expected-before and desired-after state, risk summary, `maxBatch`, and checksum. Unknown keys,
   unsupported operation kinds, origin mismatch, corruption, symlinks, oversized artifacts, and
   sensitive keys fail closed.
4. `lidarr apply --dry-run` validates the artifact, origin, referenced resources, history/resume
   state, and fresh artist state. It returns `would-apply` or `satisfied` per target and writes
   neither Lidarr state nor apply history nor deferred intents.
5. Real apply requires the existing approval gate: interactive text mode reviews and confirms;
   non-interactive and machine-output modes require `--yes`.
6. Initial apply preflight re-reads all pending targets and blocks all writes on any missing artist,
   missing referenced resource, or operation-relevant drift. Each target is re-read again
   immediately before mutation; late drift stops later admissions.
7. Profile and tag changes are local-only, idempotent desired-state operations. They do not require
   the external metadata-server health gate. Profile plans should carry medium risk because they
   alter future acquisition policy; tag plans are low risk. Both are non-destructive and must state
   that the request does not move/delete files, cancel queued downloads, trigger searches, or write
   audio tags.
8. The editor payload contains only `artistIds` plus the requested profile fields, or `artistIds`,
   `tags`, and explicit `applyTags`. It must never populate `rootFolderPath`, `moveFiles`,
   `deleteFiles`, `addImportListExclusion`, monitoring fields, or other editor capabilities.
9. Execute one artist ID per editor request under the existing plan claim and scheduler. The
   operator still receives bulk behavior, while each remote success can be durably recorded before
   the next target is admitted.
10. Treat any valid successful 2xx response, including upstream's actual `202 Accepted`, as remote
    success. A future multi-ID optimization must validate that every requested artist appears in
    the returned resource list before recording per-target success.
11. A target independently reaching the desired state is `satisfied`, not failed. Unexpected
    operation-relevant state is `blocked-stale`; there is no general force option in the current
    command surface.
12. A retryable Lidarr error is recorded as `deferred` with an idempotent operation payload. It is
    replayed only by explicit `apply --resume`; health, status, startup, and unrelated commands
    never replay it.
13. A non-retryable target failure is durably recorded and other independently eligible targets may
    continue. If a remote mutation succeeds but durable history fails, the target is `uncertain`
    and all later admissions stop.
14. Resume skips durable `succeeded` and `satisfied` targets, reconciles eligible deferred intents,
    and retries only incomplete work. Prior history without `--resume` is an error.
15. Cancellation releases the exclusive plan claim, preserves durable completed outcomes, restores
    any claimed-but-unfinished deferred intent, and requires an explicit resume.

## Workflows

### Plan a profile change

1. Parse and validate selectors, desired profile references, and `maxBatch`.
2. Resolve the canonical Lidarr origin and required client with stale fallback disabled.
3. Fetch quality profiles, metadata profiles, tags needed by selectors, and the complete artist
   list through the stable facade.
4. Resolve names to IDs, apply all selection predicates, reject unknown IDs/zero matches/cap
   overflow, and freeze targets in artist-ID order.
5. For every artist, project only the managed profile fields into reviewed before/after state.
6. Render aggregate and per-artist changes, including no-ops and profile names/IDs.
7. Seal and atomically write the mutation plan. No editor request occurs.

### Plan a tag change

1. Parse one explicit tag mode and validate selectors and tag values.
2. Resolve all selector and mutation tags before choosing artists.
3. Freeze the cohort from the pre-mutation artist snapshot.
4. Compute each full normalized before/after tag set and operation delta.
5. Render changed/no-op counts, explicit add/remove/set/clear intent, and the tags that replacement
   will discard.
6. Seal and write the plan without calling the editor.

### Validate and apply

1. Read and strictly validate the plan, checksum, target origin, operation kind, referenced
   resources, and prior history.
2. Re-read all pending artists. If any operation-relevant target is missing or drifted, report every
   finding and perform zero writes.
3. In dry-run mode, return the complete `would-apply`/`satisfied` before/after summary and stop.
4. For real apply, acquire the exclusive plan claim and require approval.
5. Re-read one artist, classify it, call the artist editor with that single ID if still ready, and
   synchronously persist its outcome.
6. Continue in deterministic order until complete, cancelled, late drift stops admission, or an
   uncertain history failure makes further execution unsafe.

### Recover a partial run

1. Operator fixes the underlying Lidarr/configuration/storage problem and invokes
   `lidarr apply <plan> --resume --yes` (or performs an interactive resume).
2. Apply validates the same plan checksum and origin and obtains the exclusive claim.
3. Durable successes and satisfied entries become `skipped-resume`.
4. Matching due deferred intents are revalidated and replayed first; other incomplete entries then
   follow normal immediate revalidation and execution.
5. The final summary remains authoritative even when the run is partial.

## Domain Model

| Entity            | Business meaning                                      | Key state                                                                              |
| ----------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Artist            | One Lidarr artist eligible for selection and mutation | ID, name, monitored, quality-profile ID, metadata-profile ID, tag IDs                  |
| Selector          | Explicit rules used once to produce a frozen cohort   | IDs, monitoring state, quality profile, metadata profile, all-of tags, or explicit all |
| Profile reference | Operator input resolved against one Lidarr origin     | Kind, stable ID, display name                                                          |
| Tag reference     | Existing Lidarr tag used for selection or mutation    | Stable ID, display label                                                               |
| Profile intent    | Desired assignment for one or both profile dimensions | Optional quality ID, optional metadata ID                                              |
| Tag intent        | Desired delta or exact tag state                      | Mode `add`, `remove`, `set`, or explicit `clear`; normalized IDs                       |
| Plan entry        | Review and idempotency unit for one artist            | Artist identity, relevant before/after state, idempotency key                          |
| Mutation plan     | Sealed review boundary                                | Version, plan ID, origin, operation, cap, entries, review, risk, checksum              |
| Staleness finding | Reason reviewed intent cannot safely execute          | Missing artist/resource or operation-relevant state drift                              |
| Apply history     | Durable authority for resume                          | Plan/checksum, entry, timestamp, terminal outcome, safe error metadata                 |
| Deferred intent   | Retryable work eligible only for explicit replay      | Origin, operation, desired payload, idempotency key, due/status                        |

Per-entry state transitions are:

```text
selected -> unchanged
selected -> ready -> would-apply                    (dry-run only)
selected -> ready -> succeeded                     (remote success + durable history)
selected -> ready -> failed                        (non-retryable failure)
selected -> ready -> deferred -> succeeded|failed  (explicit resume)
selected -> ready -> uncertain                     (remote success, history failure)
selected -> satisfied                              (already desired)
selected -> blocked-stale                          (missing or conflicting live state)
selected -> not-attempted                          (late drift/uncertainty stops admission)
completed history -> skipped-resume
```

## Existing Codebase Integration

- `packages/rfmedia-cli/src/types/lidarr.ts`: `LidarrArtist` already carries
  `qualityProfileId`, `metadataProfileId`, and tag IDs. These are the stable domain fields used for
  selection and before/after projections.
- `packages/rfmedia-cli/src/actions/lidarr/list.ts`: `matchesFilters` establishes monitored,
  unmonitored, exact quality-profile, and repeated-tag all-of semantics. Mutation planning should
  extract/reuse the selection behavior but must not reuse list paging or stale-cache consent.
  `LidarrListItem` currently omits `metadataProfileId`, so list output and filtering need an explicit
  product decision if metadata-profile targeting should be discoverable there too.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: `LidarrClientApi` is the only action-facing
  capability seam. It currently exposes profile/tag-bearing artists and the narrow
  `setArtistsMonitored` mutation. Profile/tag listing and editor methods belong here, with strict
  projection and validation; actions must not import generated operations.
- `packages/rfmedia-cli/src/lib/lidarr/generated/sdk.gen.ts`: the private generated tree already
  contains `putApiV1ArtistEditor`, `getApiV1Qualityprofile`, `getApiV1Metadataprofile`, and
  `getApiV1Tag`.
- `packages/rfmedia-cli/src/lib/lidarr/generated/types.gen.ts`: `ArtistEditorResource` confirms
  nullable profile IDs, tags, and `applyTags`; `ApplyTags` is exactly `add | remove | replace`.
  Generated response metadata says `200`, while current upstream implementation and existing
  `client.test.ts` contract use `202`; the facade/transport must retain generic successful-2xx
  handling.
- `packages/rfmedia-cli/src/lib/lidarr/types.ts`: focused unknown-to-domain projectors must be added
  for bounded profile/tag resources. Generated TypeScript types alone are not runtime validation.
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: the current exact union contains only
  `artist-monitoring`. Profile and tag operation/entry shapes, stale codes, review/output fields,
  and bounded resource references must be added without weakening exact-schema checks.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`:
  `LidarrMutationOperationDefinition` already owns canonicalization, risk, classification,
  idempotency, execution, deferred payloads, and replay matching. New operation definitions should
  preserve this single behavior owner. `buildLidarrMutationPlan` currently constructs
  monitoring-specific entries and counts changes by `monitored`; it needs operation-owned entry
  construction/change detection rather than parallel profile/tag builders that can drift.
- `packages/rfmedia-cli/src/actions/lidarr/plan.ts`: the shipped producer resolves exact artist IDs,
  rejects missing IDs, builds a complete plan, and writes it atomically. Issue #199 expands target
  resolution from exact IDs to bounded explicit filters and resource lookup.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`: current apply already performs origin/checksum
  validation, whole-plan preflight, immediate per-target revalidation, exclusive claims, durable
  outcomes, deferred retry, explicit resume, dry-run, and late-admission stop. Its stale messages
  and operation labels are monitoring-specific and must become definition-owned.
- `packages/rfmedia-cli/src/commands/lidarr.ts`: the established plan/apply approval and
  human/machine output contract should remain authoritative. Profile/tag previews need
  operation-aware renderers rather than monitoring-only columns.
- `packages/rfmedia-cli/src/lib/lidarr/tiers.ts`: these mutations use only Lidarr's local API and do
  not invoke metadata lookup or file operations, matching the current plan/apply `local-only` lane.
- `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts` and
  `lidarr-fixtures.ts`: the capability mock and artist fixture must cover new facade reads/writes;
  focused action tests should assert selector and desired-state semantics independently of live
  Lidarr.
- `packages/rfmedia-cli/src/shell-completions/`: every new command, selector, operation choice, and
  option must be mirrored in Bash, Zsh, and Fish templates and parity tests.
- `packages/rfmedia-cli/openapi/lidarr-v1.json`: the checked-in specification is the source for
  generated operations. Production code must not hand-write endpoint paths or generated DTOs.
- Upstream controller evidence:
  [`ArtistEditorController.cs`](https://github.com/Lidarr/Lidarr/blob/3d48a982d2addf5a84d22224c3ea03778cd8dc95/src/Lidarr.Api.V1/Artist/ArtistEditorController.cs)
  implements field-by-field profile updates and tag add/remove/replace, validates each artist,
  persists with `UpdateArtists`, and returns `Accepted(resources)`.
- Upstream resource/validator evidence:
  [`ArtistEditorResource.cs`](https://github.com/Lidarr/Lidarr/blob/3d48a982d2addf5a84d22224c3ea03778cd8dc95/src/Lidarr.Api.V1/Artist/ArtistEditorResource.cs)
  defines editor fields, and
  [`ArtistEditorValidator.cs`](https://github.com/Lidarr/Lidarr/blob/3d48a982d2addf5a84d22224c3ea03778cd8dc95/src/Lidarr.Api.V1/Artist/ArtistEditorValidator.cs)
  requires valid quality and metadata profile IDs.

## Success Criteria

1. Planning cannot target the whole library through omitted options; explicit selectors or
   explicit `--all` are required.
2. Exact IDs, monitored/unmonitored, quality profile, metadata profile, and repeated all-of tag
   filters have deterministic tested behavior, including zero-match, unknown-ID, duplicate-ID, and
   combined-filter cases.
3. Selection resolves the complete matching set before applying the default 25 / maximum 1,000
   batch cap; it never silently takes the first 50 or truncates cap overflow.
4. Profile and tag IDs/names resolve against fresh bounded facade projections; nonexistent or
   ambiguous references fail before artifact creation and before apply.
5. A profile plan can set quality, metadata, or both, while omitting every unmanaged editor field.
6. Tag `add`, `remove`, `set`, and explicit `clear` produce the documented union, difference,
   replacement, and empty-set results for heterogeneous starting tag sets.
7. Plan previews and every machine format report the exact origin, plan ID/checksum, operation,
   selector summary, cap, risk, changed/no-op counts, and per-artist before/after state with
   resolved names and IDs.
8. Planning and `apply --dry-run` issue zero mutation requests; apply dry-run writes no history or
   deferred intent.
9. All-no-op plans are valid, send no editor requests, and finish with every entry `satisfied`.
10. Initial missing/drifted targets or deleted referenced resources block all writes. Late drift
    stops later admissions and reports completed, blocked, and not-attempted targets accurately.
11. Delta tag operations tolerate unrelated tag changes, while exact tag replacement blocks a
    concurrent complete-set change. Profile classification ignores unmanaged fields and safely
    accepts partial convergence of multiple managed profile fields.
12. Contract tests prove exact editor bodies, one artist ID per apply request, explicit
    `applyTags`, omission of deletion/move/search fields, and acceptance of `202` as success.
13. Each terminal target outcome is durably recorded before the next admission; retryable failures
    defer idempotently, resume skips success/satisfied entries, and uncertain history failure stops
    the run.
14. No plan/history/deferred/output record contains an API key, authorization header, raw generated
    response, arbitrary response body, or credential-bearing URL.
15. New actions use the stable client facade and scheduler; architecture checks continue to reject
    generated imports above the private Lidarr layer, handwritten `/api/v1/` paths, and additional
    authenticated fetch owners.
16. Focused facade, projector, selector, plan-engine, action, apply/resume, command, completion,
    generated-contract, and architecture tests pass alongside the existing rfmedia-cli typecheck,
    build, and full suite.
17. User documentation explains selection, name/ID resolution, tag modes, profile cascade risk,
    plan review, dry-run, apply approval, resume, and recovery with exact command/output examples.

## Open Questions

1. **Command shape:** Should `lidarr profile` and `lidarr tag` be read-only plan producers that
   output a plan file, or should the canonical surface be new `lidarr plan artist-profile` and
   `lidarr plan artist-tags` leaves? Direct mutation from these commands would bypass the shipped
   review boundary and is not recommended.
2. **Exact IDs plus filters:** Should these compose as an explicit intersection with excluded-ID
   reporting, or be mutually exclusive selector modes? Either is safer than silently ignoring an
   explicit ID that does not match.
3. **Reference syntax:** Should every profile/tag option accept ID or name in one argument, or
   provide separate `--*-id` and `--*-name` flags? One argument is friendlier; separate flags remove
   numeric-label ambiguity.
4. **Combined profile fields:** Should quality and metadata profiles be assignable together in one
   profile plan? The recommended answer is yes, with per-field partial-convergence semantics.
5. **Tag clearing:** Is a dedicated `--clear`/`clear` mode acceptable, or should exact `set` permit
   an explicit empty sentinel? An accidental empty variadic argument must never clear tags.
6. **Tag creation:** Should an unknown tag name ever be auto-created? The recommended issue #199
   scope is existing tags only; creation is a separate state transition with its own rollback and
   concurrency rules.
7. **HTTP batching:** Does product value require multiple artist IDs in one editor call? Current
   safety favors one ID per request. Any optimization needs a chosen chunk size, response-ID
   validation, partial/atomic behavior proof, and durable batch recovery design.
8. **Metadata profile `None`:** Upstream issue #2302 discusses clearing a metadata profile, but the
   current validator requires a valid positive profile ID. Should unsupported clear semantics be
   explicitly documented, or pursued as a separate compatibility investigation?
9. **Plan schema evolution:** Can new operation kinds remain under `rfmedia.lidarr-plan.v1` with
   strict operation allowlisting, or should the schema version change because entry shapes and
   review fields expand? Older CLIs will reject new kinds either way.
10. **Risk labels:** Are `medium` for profile assignment and `low` for tag mutation acceptable, or
    should every multi-artist change be medium despite being local and non-file-destructive?
11. **Large previews:** Within the 1,000-target hard bound, should text always print every entry or
    provide an explicit summary mode? The artifact and machine output must still retain the complete
    cohort.
12. **Metadata-profile discovery in `lidarr list`:** Should issue #199 add
    `--metadata-profile` filtering and a metadata-profile output column to the general read command,
    or keep the new selector available only to mutation planning?
