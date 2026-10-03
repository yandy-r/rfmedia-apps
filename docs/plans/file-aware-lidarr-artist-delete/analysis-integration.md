<!-- markdownlint-disable MD026 -->

# Integration Analysis:

<!-- markdownlint-enable MD026 -->

## Executive Summary

Issue #200 fits the existing strict `rfmedia.lidarr-plan.v2` registry and plan/apply lifecycle, but
artist deletion must be treated as a distinct destructive operation rather than another editor
mutation. Planning can reuse the bounded artist selector and current `LidarrArtist` projection;
apply must use the generated single-ID delete endpoint, exact file-impact drift checks, sequential
dispatch, targeted absence verification, and two independent authorization flags.

No new runtime/development dependency or SQLite schema migration is required. Plan and apply
history remain private filesystem artifacts; the existing schema-v10 SQLite deferred queue must
explicitly exclude artist deletion. The existing JSONL history contract does need an additive,
strictly validated representation of a possible dispatch before the delete request so a crash or
cancellation cannot cause an unsafe resend on `--resume`.

## API Endpoints

### Lidarr API v1

- **Delete one artist**: `DELETE /api/v1/artist/{id}`, generated as
  `deleteApiV1ArtistById` with `DeleteApiV1ArtistByIdData`.
  - Required path: `id: number` (`int32` in the pinned OpenAPI snapshot).
  - Optional query in the generated contract: `deleteFiles?: boolean` and
    `addImportListExclusion?: boolean`, both with snapshot default `false`.
  - Issue #200 must send both values explicitly: the reviewed plan supplies `deleteFiles`, while
    `addImportListExclusion` is fixed to `false`.
  - Response: HTTP `200` with `unknown` body. The facade should use `parseAs: "stream"` and the
    existing void execution path; response content is never deletion evidence.
- **Verify one artist**: `GET /api/v1/artist/{id}`, already exposed as
  `LidarrClientApi.getArtist(id, signal)`.
  - Before dispatch, a typed `not-found` is stale and blocks the run.
  - After this plan's possible dispatch, only typed `not-found` proves the required
    `{ exists: false }` postcondition.
  - Authentication, authorization, timeout, cancellation, malformed response, and transport
    errors must remain errors, never aliases for absence.
- **Rejected bulk endpoint**: `DELETE /api/v1/artist/editor`.
  Its optional `ArtistEditorResource` body and unknown whole-request response cannot provide
  reliable per-artist attribution or partial-outcome recovery. Existing editor use for monitoring,
  profiles, and tags must not be copied for deletion.

`LidarrClientApi` should add the narrow facade method:

```ts
deleteArtist(
  artistId: number,
  deleteFiles: boolean,
  signal?: AbortSignal,
): Promise<void>;
```

The handwritten facade validates a positive safe-integer ID and a boolean, then delegates route,
method, and query serialization to generated code. The existing hardened transport remains the
only owner of canonical origin binding, `X-Api-Key` injection, redirect rejection, timeout and
cancellation composition, response limits, and typed status mapping.

### Projected Lidarr data

The existing public `LidarrArtist` projection already carries the planning inputs:
`id`, `artistName`, optional `path`, and optional `statistics`. A valid delete plan requires a
non-empty terminal-safe path plus complete non-negative safe integers for `albumCount`,
`trackFileCount`, and `sizeOnDisk`; missing values are not coerced to zero in either delete mode.
`trackCount`, `totalTrackCount`, and `percentOfTracks` are not part of reviewed delete evidence.

## Database

- **Plan artifact**: extend the closed v2 unions in
  `packages/rfmedia-cli/src/types/lidarr-plan.ts` and the exact parsing/canonicalization in
  `plan-engine.ts` with `artist-delete`. Each sorted `artist:<id>` entry seals path, album count,
  track-file count, bytes, `{ exists: false }`, and an origin/operation/payload-bound idempotency
  key. The checksum must also bind the plan-wide `deleteFiles` mode, summary totals, and high-risk
  cascade.
- **Plan history**: reuse the private per-plan JSONL path under
  `getLidarrPlanHistoryPath()`. Existing history is keyed by plan ID, checksum, and entry ID and
  atomically replaces the latest record per target. Its strict validator currently models only
  terminal outcomes, so deletion needs additive durable attempt/dispatch evidence written before
  a request may reach Lidarr, followed by the verified/failed/uncertain terminal record.
  `selectLidarrResumeEntries()` must use that evidence to distinguish:
  - initial absence with no possible dispatch: stale;
  - absence after this execution's dispatch: succeeded;
  - absence on resume with matching durable possible-dispatch evidence: satisfied;
  - ambiguous possible dispatch without verified absence: uncertain and no blind resend.
- **Claims**: retain the existing exclusive per-plan lock and ownership checks before dispatch and
  history writes. A claim prevents concurrent apply but does not replace durable attempt evidence
  across process termination.
- **SQLite**: schema v10 already contains resilience, metadata-cache, and circuit-breaker tables.
  Artist deletion must not enqueue into or register an executor for
  `lidarr_deferred_intents`; generic deferred replay would bypass the reviewed destructive apply
  boundary. Therefore no new table, column, migration, or schema-version bump is indicated.
- **Dry run**: apply dry-run may read and classify live state but must not acquire a claim, write
  JSONL history, initialize/write SQLite, mutate Lidarr/files, or call Plex. Planning dry-run must
  build and present the in-memory plan without writing the artifact.

## External Services

### Lidarr

Lidarr is authoritative for artist identity, reviewed file-impact evidence, record deletion, and
managed-file deletion. `rfmedia` never traverses, stats, unlinks, trashes, or recursively removes
local paths. The apply operation belongs in the scheduler's existing `destructive` lane, whose
defaults are concurrency `1`, operation budget `25`, and retry attempts `0`. Deletes remain
sequential in sealed artist-ID order and each scheduled mutation is non-idempotent, preventing
automatic scheduler retry.

The existing Lidarr configuration remains sufficient: `lidarr.baseUrl`, `lidarr.apiKey`,
`lidarr.timeoutMs`, and optional scheduler lane overrides. Connection CLI overrides remain
`--lidarr-url` and `--lidarr-api-key`. No new persistent Lidarr configuration is required.

### Plex Media Server

Plex is an optional post-apply integration owned by the provider-neutral
`MediaServerAdapter.scan` capability. `--plex-scan` is apply-time intent and is deliberately
excluded from the plan, checksum, idempotency key, history, and resume identity.

After all deletion processing and history writes, call the existing optional adapter resolver and
issue at most one full-library `scan.trigger()` only when the plan uses `deleteFiles: true` and at
least one newly durable `succeeded` entry has non-zero reviewed track-file or byte impact. Do not
scan on dry-run, keep-files plans, satisfied-only runs, zero-impact successes, or failed/uncertain
deletions. Do not use `triggerSource(before.path)`: the deleted path may no longer exist and no
reliable Lidarr-to-Plex library mapping is established.

Plex credentials remain inside the existing adapter/transport. Adapter absence or
`MediaServerScanResult.success === false` is reported as a separate sanitized
`unavailable`/`failed` scan result or warning; it never changes durable Lidarr outcomes, rolls back
deletion, or causes replay. Existing Plex connection configuration is sufficient, so no new
persistent scan setting is needed.

## Integration Points

- **Command/action boundary**:
  - Add `rfmedia lidarr plan artist-delete` using the existing mutually exclusive `--ids`,
    filter, or explicit `--all` selection surface, plus `--delete-files`, `--max-batch`,
    `--plan-file`, connection, output, verbose, and planning dry-run behavior.
  - Add apply-time `--allow-artist-delete`, conditional `--allow-file-delete`, and optional
    `--plex-scan`. These are cumulative with confirmation; `--yes` only bypasses the prompt.
    The same authorization flags remain mandatory on resume and must appear in recovery commands.
- **Selection/planning**: create
  `packages/rfmedia-cli/src/actions/lidarr/plan-artist-delete.ts`, reusing
  `selectLidarrArtists()` and reference resolution. Resolve one fresh complete artist snapshot,
  reject zero matches or over-cap cohorts without truncation, validate every evidence field, and
  pass `artist-delete` sources to `buildLidarrMutationPlanV2()`.
- **Operation registry**: extend `plan-operation-definitions.ts` with operation canonicalization,
  high-risk facts, entry construction, aggregate summary, payload/idempotency material, exact
  evidence drift comparison, single-ID execution, and absence verification. Its live-state
  boundary must represent present/absent explicitly; existing operations can continue requiring a
  present `LidarrArtist`.
- **Apply lifecycle**: update whole-plan preflight and just-in-time target reads so all pending
  delete entries must initially exist and match path/count/bytes. Dispatch one artist only after
  authorization, claim ownership, and durable attempt evidence. Reconciliation should invert the
  current generic treatment of `not-found` only for `artist-delete`: post-dispatch absence is
  verified, while a still-present or inconclusive target stops later admission.
- **History/deferred split**: keep verified, failed, and uncertain delete outcomes in per-plan
  JSONL history; never call `enqueueDeferredIntent`, never add a delete deferred-operation key,
  and never replay deletion through `createLidarrMutationExecutors()`.
- **Output**: extend `lidarr-mutation-presenter.ts` rather than rendering in actions. Human plan and
  confirmation output must name `keep-files`/`delete-files`, show path, albums, track files, exact
  bytes plus formatted size, totals, and irreversible risk. JSON/YAML preserve full typed entries
  and exact integers. CSV adds stable deletion evidence/mode columns without changing existing
  operation rows. Apply output preserves per-target succeeded/satisfied/stale/failed/uncertain
  distinctions and may add optional scan status; scan state does not enter immutable artifacts.
- **Scheduler and resilience**: planning/reads can retain the existing resilient client with
  in-place retry disabled at the action boundary. Mutation dispatch uses the destructive lane,
  non-idempotent task metadata, zero retries, bounded targeted reconciliation, and explicit
  operator resume only.
- **Public/docs parity**: export the new action from `actions/lidarr/index.ts`; update Commander
  hierarchy tests, client/plan/apply/output tests, Bash/Zsh/Fish completion templates and parity
  tests, `packages/rfmedia-cli/README.md`, `docs/features/lidarr-plan-apply.md`, and `ROADMAP.md`.
  Album deletion remains owned by issue #223.
