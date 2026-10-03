# File-Aware Lidarr Artist Delete: Implementation Recommendations

## Executive Summary

Implement issue #200 as an artist-only, sealed plan/apply workflow built on a new additive
`rfmedia.lidarr-plan.v2` operation, `artist-delete`. Each entry must bind one stable Lidarr artist
ID to exact Lidarr-reported path, album-count, track-file-count, and byte evidence; apply must
revalidate that evidence, require explicit artist/file deletion authority, execute the generated
single-ID endpoint sequentially, and verify absence without adding dependencies or deleting files
through local filesystem APIs.

Album selection and album deletion remain owned by #223, so no new child issue is needed. An
optional Plex scan is an apply-time follow-up after verified file-deleting success and remains
outside the sealed plan and Lidarr deletion outcome.

## Implementation Recommendations

### Key decisions

1. **Scope issue #200 to artists.** The issue's older body mentions artists/albums, but its title,
   current roadmap placement, and completed research establish an artist command. Do not accept
   album selectors or create album-level delete policy. Issue #223 is the existing owner for album
   management and deletion.
2. **Add one strict v2 operation.** Extend the existing `rfmedia.lidarr-plan.v2` discriminated
   unions with `{ kind: "artist-delete", deleteFiles: boolean }`. Preserve v1 and every existing v2
   operation byte-for-byte and behavior-for-behavior; do not introduce a parallel plan format or
   executor.
3. **Use one generated single-ID request per artist.** Add a narrow facade method backed by
   `deleteApiV1ArtistById`. Validate a positive safe-integer ID and explicit booleans, pass
   `deleteFiles` explicitly, use the hardened transport and void-response pattern, and never call
   the artist-editor bulk endpoint. Sequential requests provide attributable results and a safe
   stop boundary that the bulk endpoint cannot provide.
4. **Seal exact Lidarr-reported evidence.** Every entry must contain a non-empty `path` and exact
   non-negative safe integers for `albumCount`, `trackFileCount`, and `sizeOnDisk`. Preserve the
   exact byte integer in plans and machine output; human output may add a formatted value. Planning
   fails closed for missing or malformed evidence in both keep-files and delete-files modes so the
   v2 schema and review contract do not become mode-dependent.
5. **Treat evidence as reported impact, not a local disk manifest.** The values describe what
   Lidarr reports for the artist. They do not promise reclaimed filesystem blocks because of hard
   links, sparse files, deduplication, mount state, or Lidarr behavior. Do not add a local
   filesystem walk, file manifest, realpath/stat policy, unlink, recursive removal, trash action,
   or shell command. `deleteFiles=true` authorizes Lidarr's remote API to remove its managed files;
   the CLI itself never deletes local files.
6. **Require cumulative authorization at apply.** Real apply requires ordinary confirmation (or
   `--yes`) plus `--allow-artist-delete`. A plan with `deleteFiles: true` additionally requires
   `--allow-file-delete`. Neither allow flag implies `--yes`, and `--yes` alone grants no
   destructive authority. Require the same flags on resume. Apply dry-run performs no mutation and
   should validate which authorizations real apply would require without requiring them.
7. **Make `--delete-files` opt-in and sealed.** Omission means `deleteFiles: false`; it must be
   shown as `keep-files` in preview and stored explicitly in the plan. The combination of an
   opt-in planning flag and the independent apply-time `--allow-file-delete` gate prevents an
   omitted/default value from authorizing file deletion.
8. **Keep import-list exclusion out of the initial operation.** Issue #200 does not require this
   policy, and the technical design's minimal facade has no exclusion field. Send
   `addImportListExclusion: false` explicitly if the generated request accepts it so server
   defaults cannot change behavior. A future independently reviewed feature may expose the choice;
   it should not silently broaden this destructive plan contract.
9. **Fail closed on drift before dispatch.** At initial apply, reread all planned IDs and require
   exact equality for path, album count, track-file count, and bytes before the first mutation.
   Artist name changes are warnings because the stable Lidarr ID is authoritative. A missing artist
   on initial apply is stale, not success, because there is no evidence this plan caused its
   absence.
10. **Revalidate immediately before each delete.** After whole-plan preflight, process entries in
    sealed artist-ID order. Perform a targeted read immediately before dispatch, stop admission on
    drift, make one delete call, then use bounded targeted reads to verify a typed `not-found`.
    Authentication, authorization, timeout, malformed response, and generic transport failures
    never mean absent.
11. **Preserve uncertainty and safe resume.** Do not automatically retry a possibly dispatched
    destructive request and never enqueue `artist-delete` in the deferred replay queue. A
    pre-dispatch failure may be retried on explicit resume. A post-dispatch ambiguous result must
    be reconciled by immutable artist ID; authoritative absence may be marked `satisfied` on resume
    only when durable history proves this plan previously could have dispatched the entry.
12. **Make Plex scanning apply-time and optional.** Add `--plex-scan` to `lidarr apply`, not to the
    operation or checksum. After all Lidarr entry history is durable, request at most one full scan
    only for a non-dry-run `artist-delete` plan with `deleteFiles: true` and at least one newly
    verified success with non-zero planned file impact. Do not scan for keep-files, already
    satisfied, failed, uncertain, zero-impact, or dry-run entries.
13. **Isolate scan results.** Use the existing optional adapter resolver and `scan.trigger()`;
    loading or failing Plex must not affect request construction or cause a Lidarr delete replay.
    Report unavailable/failed scans as a structured warning while retaining the verified Lidarr
    result. This follows the adapter's best-effort result contract and resolves the research
    disagreement in favor of operational isolation.
14. **Add no dependencies or generalized framework.** Existing generated SDK, facade, plan
    engine, adapter, Commander, output, checksum, history, and test utilities cover the feature.
    Do not create a generic media deletion abstraction, second executor, album abstraction,
    filesystem deletion helper, or scan subsystem.

### Recommended contract

The minimal operation and evidence shapes should be additive:

```ts
interface LidarrArtistDeleteOperation {
  readonly kind: "artist-delete";
  readonly deleteFiles: boolean;
}

interface LidarrArtistDeleteEvidence {
  readonly path: string;
  readonly albumCount: number;
  readonly trackFileCount: number;
  readonly sizeOnDisk: number;
}
```

Each plan entry should retain `id: "artist:<id>"`, positive `artistId`, sanitized display
`artistName`, exact `before` evidence, `{ exists: false }` as the only valid `after` state, and
the existing target-bound idempotency material. Its summary should include exact artists, albums,
track files, and bytes totals. Exact-key parsing must reject unknown keys, unsafe or fractional
numbers, negative values, empty paths, inconsistent operation/entry kinds, and mismatched totals.

The apply observer needs an explicit present/absent union rather than a fabricated artist. That
union lets the operation distinguish:

- present with exact evidence: ready;
- present with changed evidence: blocked stale;
- absent on initial apply without prior dispatch: blocked stale;
- absent after this execution's dispatch: succeeded;
- absent on resume after a durable possible dispatch: satisfied;
- present after bounded post-dispatch verification: failed or uncertain according to transport
  certainty.

### Command and output surface

Add `rfmedia lidarr plan artist-delete` beside the current artist plan leaves. Reuse the existing
mutually exclusive selectors (`--ids`, `--all`, monitored/unmonitored, profile, and tag filters),
selection ordering, AND filter semantics, zero-match rejection, `--max-batch`, plan file,
connection, and output options. Do not reevaluate filters at apply; the sealed IDs are authoritative.

The new surface is:

- planning: `artist-delete` and `--delete-files`;
- apply/resume: `--allow-artist-delete`, conditional `--allow-file-delete`, and optional
  `--plex-scan`;
- completion parity: Bash, Zsh, and Fish must expose the same hierarchy and flags.

Human preview and confirmation should show artist ID/name, `keep-files` or `delete-files`, path,
album count, track-file count, exact bytes, and formatted size, plus aggregate totals and the
irreversible boundary. JSON/YAML/CSV projections must preserve exact integer values and stable
status codes while omitting credentials. Apply output must distinguish `blocked-stale`,
`succeeded`, `satisfied`, `failed`, and `uncertain`, and report scan status separately.

### Implementation phases

#### Phase 1: Domain and API boundary

- Extend `packages/rfmedia-cli/src/lib/lidarr/client.ts` and its focused tests with the
  single-artist facade method.
- Extend `packages/rfmedia-cli/src/types/lidarr-plan.ts`,
  `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`, and strict plan validation
  with the operation, evidence, summary, risk, canonicalization, and observed-state contracts.
- Prove existing v1/v2 plan fixtures and generated-client ownership rules remain unchanged.

This phase establishes the request and serialized safety boundary before command wiring can make
it reachable.

#### Phase 2: Planning and presentation

- Add `packages/rfmedia-cli/src/actions/lidarr/plan-artist-delete.ts` with existing artist
  selection helpers and one fresh Lidarr snapshot.
- Extend the plan engine and presenter for evidence totals, high-risk cascade text, deterministic
  checksum input, and all output formats.
- Reject incomplete evidence and over-cap selections before artifact creation.

This phase should be independently reviewable with mutation-free plan tests.

#### Phase 3: Apply, authorization, and reconciliation

- Extend apply dispatch and targeted-entry execution for present/absent observation, exact drift
  comparison, sequential single-ID deletion, bounded absence verification, stop-admission, and
  explicit resume classification.
- Add the two destructive authorization gates and exclude artist deletion from deferred replay.
- Preserve existing claim, history, expected-plan-ID/checksum, cancellation, and exit-code
  behavior.

This phase is the critical destructive boundary and should not be combined with optional Plex
work until its tests pass.

#### Phase 4: Optional scan and public surface

- Add apply-time `--plex-scan` through the existing adapter helper and report its structured result
  separately.
- Wire command help, presenter output, Bash/Zsh/Fish completions, documentation, examples, and
  roadmap closure.
- Run focused suites first, then package typecheck, lint, build, and the existing repository
  validation gates.

### Critical test scope

Prioritize tests that prevent broader or misattributed deletion:

- **Facade request contract:** exactly one positive ID; exact
  `DELETE /api/v1/artist/{id}` generated call; explicit `deleteFiles` and exclusion-false query;
  no handwritten route, ID array, bulk editor, redirect, implicit retry, or response-body
  dependency; typed errors and abort propagate.
- **Strict plan contract:** `artist-delete` round-trip; exact-key rejection; deterministic
  artist-ID ordering and checksum; tampered path/count/bytes rejection; correct high-risk cascade;
  exact summary totals; no change to existing v1/v2 fixtures.
- **Planning:** representative ID, all, and filter modes; selector conflicts; duplicate/unknown
  IDs; zero matches; max-batch rejection without truncation; missing/empty path; each missing or
  malformed statistic; valid zero counts and zero bytes.
- **Drift/admission:** exact match dispatches; independent path, album-count, track-file-count, and
  byte changes block before any dispatch; rename only warns; initial missing blocks; second
  just-in-time read catches post-preflight drift.
- **Authorization:** confirmation alone and `--yes` alone cannot delete; keep-files needs artist
  authorization; delete-files needs both allow flags; resume repeats the requirements; dry-run
  makes no claims, history writes, Lidarr mutations, local filesystem changes, or Plex calls.
- **Outcome certainty:** delete plus targeted not-found succeeds; response success while still
  present does not; lost response plus subsequent not-found reconciles; inconclusive verification
  stops later entries; resume never blindly redispatches an uncertain entry; artist deletion is
  never deferred or background-replayed.
- **Plex isolation:** exactly one scan after eligible verified success; none for keep-files,
  initial-missing, zero-impact, dry-run, failed, or uncertain cases; missing/failing adapter does
  not rewrite or replay completed Lidarr entries.
- **CLI/output:** help hierarchy, option conflicts, exact evidence across human/JSON/YAML/CSV,
  sanitized untrusted strings, no credential leakage, and Bash/Zsh/Fish parity.

Avoid exhaustive formatting snapshots and repeated assertions at every layer. Put request-shape,
schema, policy, and CLI tests at the layer that owns each contract, with a small command-to-facade
integration test for wiring.

### Task breakdown

1. **Facade task:** client method, interface/mock updates, and focused request/error tests.
2. **Plan-contract task:** v2 types, operation definition, strict parsing/canonicalization,
   summary/evidence checks, and compatibility tests.
3. **Planning task:** artist-delete planning action, selector reuse, exact evidence collection,
   presenter projection, and plan-action tests.
4. **Apply-safety task:** present/absent observation, whole-plan plus just-in-time drift checks,
   authorization, sequential dispatch, verification, history/resume behavior, and deferred-queue
   exclusion.
5. **Integration task:** optional Plex scan, command wiring, output/recovery messaging,
   completions, docs, roadmap, and focused end-to-end command tests.

Tasks 1 and 2 can proceed independently; task 3 depends on task 2; task 4 depends on tasks 1 and 2;
task 5 depends on tasks 3 and 4. Keep ownership cohesive and do not split the plan type,
operation-definition, and canonicalization changes among parallel edits.

### Alternatives considered

- **Generated artist-editor bulk delete:** rejected because it collapses per-artist attribution,
  partial failure, verification, and safe resume into one unknown response. Fewer requests do not
  justify weaker destructive guarantees.
- **Direct delete command without a plan:** rejected because it bypasses sealed selection,
  checksum binding, evidence review, drift detection, and durable recovery.
- **Album and artist deletion in one operation:** rejected because album semantics and cascades
  differ and #223 already owns that feature.
- **Local filesystem inventory/deletion:** rejected because Lidarr may be remote, local paths may
  not represent its filesystem, and local mutation would create a second destructive authority.
- **Path-scoped Plex scans:** rejected for the first release because the artist path may no longer
  exist after deletion and path/library mapping adds ambiguity. One post-apply full scan reuses the
  stable adapter contract.
- **New dependency or generic deletion framework:** rejected because current primitives cover the
  bounded artist workflow and generalization would enlarge the safety and review surface.
- **Treating any missing target as success:** rejected because absence before this plan's dispatch
  cannot prove that this plan achieved the reviewed operation.

### Child-issue decision and open questions

No new child issue is required for #200. Close its artist-delete scope when the implementation,
documentation, tests, and roadmap update ship; leave album deletion in #223.

The following questions should be answered during implementation without expanding the scope:

- Confirm against the pinned OpenAPI contract and a disposable supported Lidarr instance that
  explicit `deleteFiles=false/true` and `addImportListExclusion=false` have the expected behavior,
  including empty successful responses and directory cleanup. Destructive live testing must use
  disposable media, never a real library.
- Confirm the current apply engine's distinction between pre-dispatch failure and possibly
  dispatched uncertainty is strong enough to support the missing-target resume rule. If it is not,
  fail uncertain entries closed rather than add automatic retry.
- Confirm whether structured scan failure can be represented without changing the existing apply
  result schema incompatibly. If not, emit a credential-free warning and keep scan reporting out
  of persisted plan/history data.

Import-list exclusion is intentionally not an open decision for this delivery: it remains false.
If operators need configurable exclusion behavior, track it as a separate follow-up with its own
preview, verification, and recovery semantics.

## Risk Assessment

| Risk                                                          | Severity | Mitigation and acceptance evidence                                                                                                                           |
| ------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Wrong artist or broadened cohort is deleted                   | Critical | Seal positive stable IDs, deterministic bounded selection, exact checksum, target-origin binding, no filter reevaluation, and one-ID dispatch.               |
| Files are deleted without independent consent                 | Critical | Safe `deleteFiles=false` default, visible sealed mode, `--delete-files` at plan time, and cumulative `--allow-file-delete` at apply.                         |
| Stale path/count/byte evidence authorizes changed impact      | Critical | Require complete exact evidence, whole-plan preflight, immediate per-target reread, and stop before dispatch on any mismatch.                                |
| CLI deletes files outside Lidarr's authority                  | Critical | No local filesystem mutation or shell deletion code; only the reviewed generated Lidarr endpoint may receive `deleteFiles=true`.                             |
| Timeout or cancellation causes duplicate destructive calls    | Critical | No automatic retries or deferred replay; persist possible dispatch, reconcile by targeted read, and stop on uncertainty.                                     |
| Plan tampering or schema ambiguity changes intent             | Critical | Closed exact-key v2 parsing, canonical ordering, checksum over all destructive fields, target binding, and refusal to migrate/repair at apply.               |
| Bulk partial failure is misreported                           | High     | Sequential single-ID calls, per-entry durable history, bounded verification, stop-admission, explicit failed/uncertain states, and pinned resume.            |
| Missing target is falsely attributed to this plan             | High     | Treat initial absence as stale; allow satisfied only after durable evidence of a prior possible dispatch by this plan.                                       |
| Lidarr API semantics differ from the snapshot                 | High     | Pin generated code, send both query booleans explicitly, use typed transport errors, and run disposable-instance contract tests before destructive live use. |
| Plex failure causes deletion replay or false rollback         | Medium   | Run once after durable qualifying success, keep scan out of plan/checksum/history, and report a separate best-effort result.                                 |
| Artist/path data or credentials leak                          | Medium   | Never serialize credentials, sanitize untrusted display strings, use private atomic plan artifacts, and keep messages credential-free.                       |
| Compatibility regression affects existing operations          | Medium   | Additive v2 union only, unchanged v1/v2 fixtures, focused exact-key tests, output compatibility checks, and full package validation.                         |
| Large selections overload Lidarr or produce long partial runs | Medium   | Existing `--max-batch`, deterministic sequential execution, bounded reads/verification, progress, cancellation at entry boundaries, and resumable history.   |

The residual irreversible risk is explicit: a verified artist record may be recreated, but files
removed by Lidarr cannot be restored by the plan, history, resume, or Plex scan. Documentation and
the final confirmation must say this plainly and direct operators to validate backups before using
`delete-files`.
