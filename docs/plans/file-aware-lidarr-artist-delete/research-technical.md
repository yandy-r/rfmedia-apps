# File-Aware Lidarr Artist Delete: Technical Design

## Executive Summary

Implement artist deletion as a new, additive `rfmedia.lidarr-plan.v2` operation named
`artist-delete`. It should reuse the existing artist selection model, seal exact file-impact
evidence into every entry, and pass through the same checksum, claim, history, sequential
dispatch, and bounded verification boundary as the existing artist mutations. Deletion is
always a high-risk destructive lane: apply requires explicit artist-delete authorization, and
deleting files requires a second, narrower authorization.

The reviewed artifact is the authority. Planning must fail when an artist lacks a non-empty
`path` or complete statistics, because `path`, `albumCount`, `trackFileCount`, and `sizeOnDisk`
are the evidence the operator reviews before authorizing deletion. Apply admits a present
artist only when all four live values still exactly match `before`; an absent artist is already
satisfied. After a single-ID delete request, only a targeted not-found response verifies the
postcondition. Album deletion is deliberately out of scope because issue #223 owns albums.

Key implementation surfaces are:

- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: extend all strict v2 discriminated unions,
  observed state, summaries, and failure contracts.
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`: own canonicalization,
  risk, entry construction, drift classification, payload, execution, and verification.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: add exact allowlist validation,
  canonical serialization, checksum participation, and summary validation.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: expose one strictly validated,
  generated-client-backed single-ID delete method.
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-delete.ts`: resolve the existing artist
  selector surface and construct evidence-complete sources from one fresh artist snapshot.
- `packages/rfmedia-cli/src/actions/lidarr/apply*.ts`: recognize not-found as the deletion
  postcondition, enforce authorization, and expose optional post-success scan results.
- `packages/rfmedia-cli/src/commands/lidarr.ts` and
  `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`: register flags and render
  file-impact evidence in human and machine output.
- `packages/rfmedia-cli/src/lib/adapters/action-helpers.ts`: reuse
  `resolveOptionalScanAdapter()` for a best-effort Plex scan after successful file deletion.
- `packages/rfmedia-cli/src/lib/shell-completions/{bash,zsh,fish}.ts`: mirror the command and
  apply flags exactly.

## Architecture Design

### Command and selection boundary

Add `rfmedia lidarr plan artist-delete` after the existing artist plan commands. Give it the
same mutually exclusive selection modes already used by artist profiles and tags:

- `--ids <ids>`
- `--all`
- `--select-monitored` / `--select-unmonitored`
- `--select-quality-profile <reference>`
- `--select-metadata-profile <reference>`
- repeatable `--select-tag <reference>`
- the shared `--max-batch`, `--plan-file`, connection, and output options

The operation-specific choice is `--delete-files`. Omission means remove the artist from
Lidarr without asking Lidarr to delete its files; presence is sealed as
`operation.deleteFiles: true`. There is no album selector or album target in this command.

The new action should extract or reuse the common selection resolution currently duplicated
between `plan-artist-profiles.ts` and `plan-artist-tags.ts`: load artists plus only the profiles
and tags required by filter references, resolve names/IDs, call `selectLidarrArtists()`, and
produce the canonical `LidarrPlanSelectionV2`. The selected artists must be sorted and bounded
by the existing plan builder. Before calling the builder, reject every selected artist whose
`path` is absent/empty or whose `statistics` block does not provide all of `albumCount`,
`trackFileCount`, and `sizeOnDisk`. Do not coerce missing values to zero.

### Strict v2 operation definition

Add `artist-delete` to `LidarrMutationOperationV2`,
`LidarrMutationPlanEntryV2`, `LidarrPlanOperationSummaryV2`, and
`LidarrMutationPlanV2`. Keep v1 and the legacy v1 album-monitoring lane unchanged. The operation
definition should be the single behavior owner:

- Canonical operation: `{ kind: "artist-delete", deleteFiles: boolean }`.
- Risk: `{ level: "high", destructive: true, cascade: [...] }`; the cascade must state that
  the artist and its Lidarr metadata are removed, album records are removed as part of the
  artist cascade, and on-disk files are deleted only when `deleteFiles` is true.
- References: none.
- Change detection: every present planned artist is changed; deletion has no meaningful
  unchanged entry at plan time.
- Payload and idempotency material: exact `{ artistId, deleteFiles }`, bound to target origin
  and operation kind.
- Entry ID: retain `artist:<id>` so history, sorting, and existing artist result projection
  remain compatible.
- Execution: call the client once for exactly one artist ID. Never batch deletes.

The current operation-definition interface assumes that a live `LidarrArtist` always exists.
Extend its live input to an explicit present/absent union, or add an operation-owned targeted
load method. Avoid synthesizing a fake artist. For `artist-delete`:

1. Absent before dispatch classifies as `satisfied`.
2. Present with exact evidence equality classifies as `ready`.
3. Present with any path/count/size mismatch classifies as `drifted`.
4. Absent after dispatch verifies success.
5. Present after the bounded reconciliation window is verification failure/inconclusive
   according to the existing transport certainty rules.

Only a typed Lidarr `not-found` from `getArtist(id)` means absent. Authentication,
authorization, timeout, malformed response, and transport errors remain failures; they must
never be interpreted as successful deletion.

Deletion should not be replayed by the generic deferred queue. A retryable failure before a
confirmed dispatch can be resumed from the sealed plan, while an ambiguous post-dispatch
failure must reconcile by targeted read and stop admission if absence cannot be established.
This keeps the high-risk operation behind its original reviewed artifact and authorization
flags instead of allowing background replay without an operator-facing apply boundary.

### Client and apply lifecycle

Extend `LidarrClientApi` with:

```ts
deleteArtist(
  artistId: number,
  deleteFiles: boolean,
  signal?: AbortSignal,
): Promise<void>;
```

The implementation validates one positive safe integer and one boolean, then invokes the
generated single-artist delete endpoint with the `deleteFiles` query value. The generated
client remains responsible for the route and serialization; the handwritten facade retains
operation naming and the typed `LidarrError` boundary. Tests must prove that arrays and bulk
editor endpoints are not used.

Non-dry-run apply authorization is cumulative:

- existing approval: interactive confirmation or `--yes`;
- `--allow-artist-delete` for every `artist-delete` plan;
- `--allow-file-delete` when `operation.deleteFiles` is true.

Neither destructive flag implies `--yes`, and interactive confirmation must not bypass either
flag. Dry-run reads and validates the plan without requiring destructive authorization because
it performs no mutation, matching the current tag-replacement behavior. Preserve expected
plan ID/checksum pinning, exclusive claims, per-entry durable history, `--resume`, and
stop-admission behavior.

Preflight reads each target and performs exact evidence comparison. A target already absent is
recorded as `satisfied`; a changed path, album count, track file count, or size is
`blocked-stale` with an `artist-state-drift` finding that identifies which reviewed evidence
changed without exposing credentials. Dispatch and reconciliation remain sequential. A delete
response alone is not success: a fresh targeted read must return typed not-found. This also
turns a lost successful response into a verified success and makes resume naturally
idempotent.

### Optional Plex scan

Add `--plex-scan` to `lidarr apply`, not to the sealed mutation operation. It is an
apply-time, best-effort integration and therefore must not affect the checksum or deletion
authorization. After all entry work and history writes complete, call
`resolveOptionalScanAdapter({ plexScan: true })` and trigger one library scan only when:

- the plan is `artist-delete` with `deleteFiles: true`;
- apply is not a dry-run;
- at least one entry reached durable `succeeded`;
- the successful entries' reviewed `trackFileCount` or `sizeOnDisk` indicates file impact.

Do not scan for satisfied/already-missing entries, file-preserving deletes, failed/uncertain
deletes, or dry-runs. A missing adapter or failed scan is a warning and a structured
`scan.status` (`unavailable` or `failed`), not a rollback or deletion failure. Machine output
must expose `requested`, `attempted`, `status`, and a credential-free message; human output
must print the same outcome after the apply summary. A full-library `scan.trigger()` is safer
than `triggerSource(before.path)` after deletion because the reviewed source path may no longer
exist.

### Output, documentation, and roadmap

Extend the mutation presenter rather than adding action-layer rendering. Plan output must show
artist ID/name, delete-files mode, path, album count, track file count, and formatted/on-wire
size. Apply output must distinguish `satisfied` (already absent), `succeeded` (targeted
not-found verified), stale evidence, uncertain verification, and optional Plex scan status.
JSON/YAML retain exact numeric byte counts; CSV adds stable deletion evidence columns without
changing existing operation rows.

Update:

- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md` with examples, exact evidence
  semantics, both authorization flags, resume behavior, and scan behavior.
- `packages/rfmedia-cli/README.md` and root command documentation with the new plan leaf and
  apply flags.
- `ROADMAP.md` to mark issue #200's artist-delete scope complete while retaining issue #223 as
  the owner of album deletion.
- all three shell templates and `templates.spec.ts`; completion parity is part of the command
  contract.

### Critical tests

- Plan action: every selector mode, canonical selection, sorted IDs, max-batch rejection,
  missing artist, missing/empty path, missing statistics, and zero-valued complete statistics.
- Plan contracts: exact-key rejection, operation/entry/summary correlation, deterministic
  checksum, evidence tamper detection, high-risk cascade equality, and unchanged v1/v2
  fixtures for existing operations.
- Client: one positive ID per delete, exact `deleteFiles` serialization, abort propagation,
  typed not-found, authentication/authorization errors, and no bulk call.
- Apply admission: exact evidence match is ready; each of path, `albumCount`,
  `trackFileCount`, and `sizeOnDisk` drifting independently blocks before dispatch.
- Apply idempotency: already missing is durable `satisfied`; successful dispatch plus
  not-found is `succeeded`; lost response plus not-found is `succeeded`; present after bounded
  verification is failed/inconclusive and stops further admission.
- Authorization: `--yes` alone is insufficient; artist-only deletion needs
  `--allow-artist-delete`; file deletion needs both destructive flags; dry-run mutates nothing;
  expected ID/checksum and resume behavior remain enforced.
- Resilience: artist-delete is never enqueued or replayed by the deferred queue.
- Scan: exactly one scan after durable file-deleting success; none for dry-run,
  file-preserving, satisfied-only, failed, or uncertain runs; unavailable/failing adapter is
  represented without changing the apply outcome.
- Output: human, JSON/YAML, and CSV expose the same evidence and authorization-relevant mode
  without leaking API keys; pre-existing operation snapshots remain stable.
- Commands/completions: hierarchy ordering, option conflicts, help text, and Bash/Zsh/Fish
  parity include `artist-delete`, `--delete-files`, `--allow-artist-delete`,
  `--allow-file-delete`, and `--plex-scan`.

## Data Models

Recommended additive contracts:

```ts
export interface LidarrArtistDeleteOperation {
  readonly kind: "artist-delete";
  readonly deleteFiles: boolean;
}

export interface LidarrArtistDeleteEvidence {
  readonly path: string;
  readonly albumCount: number;
  readonly trackFileCount: number;
  readonly sizeOnDisk: number;
}

export interface LidarrArtistDeletePlanEntry {
  readonly id: string;
  readonly artistId: number;
  readonly artistName: string;
  readonly before: LidarrArtistDeleteEvidence;
  readonly after: { readonly exists: false };
  readonly idempotencyKey: string;
}

export interface LidarrArtistDeletePlanSource {
  readonly kind: "artist-delete";
  readonly artistId: number;
  readonly artistName: string;
  readonly path: string;
  readonly albumCount: number;
  readonly trackFileCount: number;
  readonly sizeOnDisk: number;
}

export interface LidarrArtistDeleteSummary {
  readonly kind: "artist-delete";
  readonly artists: number;
  readonly albums: number;
  readonly trackFiles: number;
  readonly sizeOnDisk: number;
}
```

All counts and bytes are non-negative safe integers; `artistId` remains a positive safe
integer; `path` is a non-empty string. Exact-key validators must reject additional keys,
negative/fractional/unsafe values, a deletion `after` value other than `{ exists: false }`,
and mismatched summary totals. Canonicalization preserves the existing artist-ID sort order
and serializes the four evidence fields in the declared order before computing the checksum.

Extend observed state with an explicit existence model:

```ts
type LidarrArtistDeleteObservedState =
  | {
      readonly kind: "artist-delete";
      readonly exists: true;
      readonly path: string;
      readonly albumCount: number;
      readonly trackFileCount: number;
      readonly sizeOnDisk: number;
    }
  | {
      readonly kind: "artist-delete";
      readonly exists: false;
    };
```

Use the same union for internal live classification and public apply evidence so the
present/absent distinction cannot be lost. Add `artist-delete` to structured failure operation
unions, but keep `artist-missing` semantics operation-aware: missing is stale for mutations
that require a present artist and satisfied for deletion.

If scan reporting is added to `LidarrPlanApplyResult`, keep it optional so existing consumers
and immutable historical artifacts remain compatible:

```ts
interface LidarrApplyScanResult {
  readonly requested: boolean;
  readonly attempted: boolean;
  readonly status: "not-requested" | "skipped" | "succeeded" | "failed" | "unavailable";
  readonly message?: string;
}
```

The scan result is runtime output, not plan data and not plan history. The plan itself contains
no Plex configuration, library name, API URL, token, or scan authorization.
