# Feature Spec: File-Aware Lidarr Artist Delete

## Executive Summary

Issue #200 will add `rfmedia lidarr plan artist-delete`, an artist-only destructive workflow built
on the existing sealed Lidarr plan/apply engine. Planning resolves an explicit bounded artist
cohort and seals each artist's Lidarr-reported path, album count, track-file count, and bytes
alongside a plan-wide keep-files or delete-files policy; apply revalidates that evidence, requires
independent destructive authority, deletes one artist at a time through the generated single-ID
endpoint, and verifies absence before recording success. The CLI never traverses or deletes the
local filesystem, and an optional Plex scan runs only after verified file-deleting success. Album
deletion remains in issue #223, so issue #200 requires no child issue.

## External Dependencies

### APIs and Services

#### Lidarr API v1

- **Authoritative contract**:
  [Pinned OpenAPI snapshot](https://raw.githubusercontent.com/Lidarr/Lidarr/3e2858439ff35b372d0af00bcea1b0a357572d26/src/Lidarr.Api.V1/openapi.json)
- **Authentication**: `X-Api-Key`, injected only by the existing origin-bound hardened transport.
- **Key endpoint**: `DELETE /api/v1/artist/{id}` with explicit `deleteFiles` and
  `addImportListExclusion` query booleans.
- **Response**: HTTP 200 with an unspecified body; the facade must use the established void-response
  path and verify the postcondition with targeted reads.
- **Rejected endpoint**: `DELETE /api/v1/artist/editor`; its unknown whole-batch response cannot
  attribute partial outcomes or support safe per-target recovery.
- **Rate limits and pricing**: Self-hosted; no published service-side rate or pricing contract.
  Existing destructive-lane budgets and sequential execution are the controlling limits.

#### Plex Media Server

- **Integration owner**: Existing provider-neutral `MediaServerAdapter.scan`.
- **Authentication**: Existing Plex adapter credential boundary; no Plex credential enters a
  Lidarr plan, checksum, history row, or deletion request.
- **Operation**: One best-effort full-library `scan.trigger()` after qualifying deletion results.
- **Failure contract**: Scan failure is reported independently and never rolls back, reclassifies,
  or causes replay of a verified Lidarr deletion.

### Libraries and SDKs

| Library               | Version                   | Purpose                              | Change                                       |
| --------------------- | ------------------------- | ------------------------------------ | -------------------------------------------- |
| `@hey-api/openapi-ts` | `0.93.0`                  | Generates the private Lidarr SDK     | Reuse committed output; no dependency change |
| Commander.js          | Existing lockfile version | CLI hierarchy and option conflicts   | Reuse                                        |
| Vitest                | Existing lockfile version | Focused contract tests               | Reuse                                        |
| Node.js crypto        | Node.js 22+               | Existing canonical SHA-256 plan seal | Reuse                                        |

No new runtime or development dependency is justified.

### External Documentation

- [`lidarr-v1.manifest.json`](../../../packages/rfmedia-cli/openapi/lidarr-v1.manifest.json):
  pinned source, generator, integrity, and generated-client provenance.
- [`lidarr-generated-client.md`](../../../packages/rfmedia-cli/docs/features/lidarr-generated-client.md):
  generated-code ownership and transport boundaries.
- [`lidarr-plan-apply.md`](../../../packages/rfmedia-cli/docs/features/lidarr-plan-apply.md):
  current artifact, apply, verification, history, and recovery contract.

## Business Requirements

### User Stories

- As an operator, I can select exact artists by IDs, existing AND-combined filters, or explicit
  `--all`, so omission never implies the whole library.
- As an operator, I can review every artist's name, ID, path, album count, track-file count, and
  exact bytes before saving or applying a destructive plan.
- As an operator, I can remove artist records while retaining files, or explicitly opt into asking
  Lidarr to delete its managed files.
- As an automation user, I can skip an interactive prompt with `--yes`, but only after supplying
  the destructive authorization flags required by the reviewed plan.
- As an operator, I receive per-target succeeded, satisfied, stale, failed, or uncertain outcomes
  and a safe resume path after partial completion.
- As a Plex user, I can request one post-delete scan without coupling Plex availability to Lidarr
  deletion correctness.

### Business Rules

1. **Artist-only scope**: The plan accepts artist selectors only. Album deletion stays in #223.
2. **Explicit bounded selection**: Exactly one of IDs, filters, or `--all` is required. Resolve the
   complete cohort during planning, sort by stable artist ID, reject zero matches, and reject
   cohorts above `--max-batch` without truncation.
3. **Plan-wide delete mode**: Omission of `--delete-files` seals `deleteFiles: false` and displays
   `keep-files`; the flag seals `deleteFiles: true` and displays `delete-files`.
4. **No import-list policy expansion**: Send `addImportListExclusion: false` explicitly. Configurable
   exclusions are not required by #200 and need a separately reviewed workflow if added later.
5. **Complete review evidence**: Every selected artist requires a non-empty Lidarr path and complete
   non-negative safe-integer `albumCount`, `trackFileCount`, and `sizeOnDisk`. Zero is valid;
   missing or malformed evidence blocks planning.
6. **Reported impact semantics**: Evidence describes Lidarr's view, not guaranteed reclaimed disk
   blocks. rfmedia performs no filesystem walk, manifest, stat, unlink, trash, or recursive delete.
7. **Layered authority**: Real apply always requires `--allow-artist-delete`; file-deleting plans
   additionally require `--allow-file-delete`. These flags are mandatory in interactive,
   non-interactive, and resume flows. They do not imply `--yes`.
8. **Dry-run precedence**: Planning dry-run writes no artifact. Apply dry-run performs validation
   and drift classification but acquires no claim and writes no history, Lidarr state, files,
   import-list exclusion, or Plex scan.
9. **Whole-plan and just-in-time drift checks**: Before the first mutation, all targets must exist
   and match their sealed path/count/byte evidence. Each target is reread immediately before its
   delete. Initial absence is stale because file-deletion postconditions cannot be proven.
10. **Sequential attributable mutation**: Apply sends exactly one generated single-ID request per
    admitted artist, in sealed order, with no automatic mutation retry and no generic deferred
    replay.
11. **Verified postcondition**: A successful HTTP response is not completion. Only an authoritative
    targeted not-found after this plan's dispatch verifies success; other errors never imply
    absence.
12. **Uncertainty stops admission**: Drift, lost claim, failed verification, cancellation after
    possible dispatch, or inconclusive state stops later entries and produces a non-zero partial
    result with pinned recovery guidance.
13. **Plex isolation**: `--plex-scan` is apply-time intent outside the plan. One scan is eligible
    after at least one newly verified file-deleting success with non-zero reviewed file impact,
    including a partial run. Scan failure is a separate warning/result and never replays deletion.

### Edge Cases

| Scenario                               | Expected Behavior                                      | Notes                             |
| -------------------------------------- | ------------------------------------------------------ | --------------------------------- |
| Artist renamed after planning          | Warn, continue if stable ID and impact evidence match  | Name is a display label           |
| Path or any count/byte changes         | Block before dispatch                                  | Regenerate and review the plan    |
| Artist missing on initial apply        | Block as stale                                         | Cannot prove reviewed file effect |
| Artist missing after possible dispatch | Reconcile using this plan's durable attempt evidence   | Never blindly resend              |
| Zero files and zero bytes              | Valid plan and delete; no Plex scan eligibility        | Zero remains explicit             |
| Missing path/statistics                | Planning fails                                         | No coercion to zero               |
| Empty 200 delete response              | Ignore body and verify targeted absence                | Matches pinned OpenAPI            |
| Plex unavailable or scan fails         | Preserve deletion result; emit separate warning/result | No rollback or replay             |

### Success Criteria

- [ ] Human and machine plan output show the complete bounded cohort and exact per-target/aggregate
      file-impact evidence.
- [ ] Sealed v2 artifacts bind target origin, selection, mode, evidence, risk, ordering, and
      idempotency keys under the existing strict checksum contract.
- [ ] Keep-files requests explicitly send `deleteFiles=false`; file deletion cannot dispatch
      without both destructive authorization flags.
- [ ] Apply blocks all reviewed evidence drift before mutation and catches drift introduced between
      whole-plan preflight and per-target dispatch.
- [ ] Each admitted target has durable attributable history and verified, failed, or uncertain
      outcome; no artist-editor bulk delete or automatic destructive retry exists.
- [ ] Optional Plex scanning occurs only after a qualifying verified success and remains independent
      from Lidarr result classification.
- [ ] Bash, Zsh, and Fish completions, README, feature documentation, and `ROADMAP.md` match the
      shipped command surface.

## Technical Specifications

### Architecture Overview

```text
rfmedia lidarr plan artist-delete
        |
        v
commands/lidarr.ts -> actions/lidarr/plan-artist-delete.ts
        |                         |
        |                         v
        |               existing artist selection
        |                         |
        v                         v
strict v2 plan types <- operation registry/plan engine
        |
        v
rfmedia lidarr apply <plan>
        |
        +--> cumulative authorization + claim + history
        |
        +--> targeted read -> single-ID delete -> targeted absence verification
        |
        `--> optional one-shot Plex scan after qualifying verified success
```

The generated SDK and hardened transport remain private. Command code never imports generated
types or constructs `/api/v1/` routes.

### Data Models

#### Operation and evidence

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

#### Plan entry and summary

```ts
interface LidarrArtistDeletePlanEntry {
  readonly id: string;
  readonly artistId: number;
  readonly artistName: string;
  readonly before: LidarrArtistDeleteEvidence;
  readonly after: { readonly exists: false };
  readonly idempotencyKey: string;
}

interface LidarrArtistDeleteSummary {
  readonly kind: "artist-delete";
  readonly artists: number;
  readonly albums: number;
  readonly trackFiles: number;
  readonly sizeOnDisk: number;
}
```

All plan objects are closed exact-key structures. Counts and bytes are non-negative safe integers;
path is non-empty and terminal-safe; entries are unique and sorted by artist ID; summary totals,
operation mode, risk facts, entry postconditions, and idempotency keys must correlate exactly.

#### Observed existence

```ts
type LidarrArtistDeleteObservedState =
  | {
      readonly kind: "artist-delete";
      readonly exists: true;
      readonly evidence: LidarrArtistDeleteEvidence;
    }
  | {
      readonly kind: "artist-delete";
      readonly exists: false;
    };
```

Only typed not-found becomes `exists: false`. Authentication, authorization, timeout, cancellation,
malformed response, and transport errors remain errors.

#### Optional scan result

```ts
interface LidarrApplyScanResult {
  readonly requested: boolean;
  readonly attempted: boolean;
  readonly status: "not-requested" | "skipped" | "succeeded" | "failed" | "unavailable";
  readonly message?: string;
}
```

This is optional runtime output, not plan, checksum, history, or resume data.

### API Design

#### `LidarrClientApi.deleteArtist`

```ts
deleteArtist(
  artistId: number,
  deleteFiles: boolean,
  signal?: AbortSignal,
): Promise<void>;
```

The facade validates one positive safe integer and one boolean, then calls the generated
`deleteApiV1ArtistById` with:

```ts
{
  path: { id: artistId },
  query: {
    deleteFiles,
    addImportListExclusion: false,
  },
  parseAs: "stream",
  signal,
}
```

No array, bulk editor, response-body projection, handwritten route, redirect, or automatic retry is
allowed.

### System Integration

#### Files to Create

- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-delete.ts`: resolve selection and build
  evidence-complete sources for the v2 plan builder.
- A focused colocated test file only if existing plan-action suites cannot cleanly own the new
  planning contract.

#### Files to Modify

- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: additive operation, entry, summary, observed
  state, result, and option contracts.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: generated single-ID facade method.
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`: operation-owned construction,
  risk, payload, drift, execution, and verification behavior.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: strict parsing, canonical checksum,
  correlation, summary, and apply classification.
- `packages/rfmedia-cli/src/actions/lidarr/index.ts` and apply modules: export the plan action,
  enforce destructive authority, preserve certainty, and trigger/report optional scanning.
- `packages/rfmedia-cli/src/commands/lidarr.ts` and mutation presenter: command, flags, human output,
  machine projections, and recovery text.
- `packages/rfmedia-cli/src/lib/shell-completions/{bash,zsh,fish}.ts` and completion tests: exact
  command/flag parity.
- `packages/rfmedia-cli/README.md` and
  `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`: user and maintenance documentation.
- `ROADMAP.md`: mark #200's artist-delete scope shipped while retaining #223 for albums.

#### Configuration

No new persistent configuration is required. `--plex-scan` uses the existing optional adapter
resolver and configured Plex connection.

## UX Considerations

### User Workflows

#### Primary workflow

1. Run `rfmedia lidarr plan artist-delete` with one explicit selection mode and optional
   `--delete-files`.
2. Review artist rows and aggregate albums, files, and exact bytes. Planning dry-run stops here
   without an artifact.
3. Save and inspect the private sealed plan.
4. Run `rfmedia lidarr apply <plan>` with `--allow-artist-delete`, conditional
   `--allow-file-delete`, optional `--plex-scan`, and `--yes` when non-interactive.
5. Review live-state classification and confirm in human mode.
6. Receive per-target outcomes, separate scan status, and a pinned resume command when incomplete.

#### Error recovery workflow

1. Schema, checksum, origin, authorization, missing-target, or impact drift fails before mutation.
2. The CLI identifies the failing artist and field without leaking credentials or raw response
   bodies.
3. Pre-dispatch stale plans require regeneration. Possible-dispatch uncertainty requires explicit
   resume with the original plan ID/checksum and destructive authority flags.

### UI Patterns

| Surface        | Pattern                                          | Requirement                      |
| -------------- | ------------------------------------------------ | -------------------------------- |
| Human plan     | Summary plus bounded rows; `--verbose` for all   | Show exact and formatted bytes   |
| Confirmation   | Default-no irreversible warning                  | Name keep/delete mode and totals |
| Machine output | One stable document on stdout                    | Diagnostics/progress on stderr   |
| Untrusted text | Existing terminal sanitizer and safe serializers | No control/bidi injection        |
| Partial result | Durable per-entry statuses plus recovery command | Never collapse uncertainty       |

### Accessibility Requirements

- Do not rely on color alone; every status and delete mode has explicit text.
- Keep prompts concise, default-no, and readable without ANSI support.
- Preserve exact numeric values in machine formats and avoid ambiguous human abbreviations.

### Performance UX

- Reuse existing bounded selection and destructive-lane budgets.
- Resolve the planning cohort from one fresh complete artist snapshot, then use targeted reads for
  apply preflight and just-in-time checks.
- Execute deletes sequentially for attribution and safe stop boundaries.
- Human output is bounded by default; machine output and sealed plans retain the complete cohort.
- Cancellation stops at an entry boundary and prints recovery guidance.

## Recommendations

### Implementation Approach

**Recommended strategy**: Add one narrow vertical slice to the existing v2 mutation registry. Keep
the generated-client facade, plan contracts, planning action, apply safety, and public integration
as separately reviewable tasks, then validate the destructive boundary before adding optional Plex
behavior.

**Phasing:**

1. **Domain and API boundary**: client method, strict operation/evidence types, parsing, checksum,
   risk, and compatibility tests.
2. **Planning and presentation**: artist selection, evidence collection, plan summaries, and
   human/machine preview.
3. **Apply safety**: cumulative authority, whole-plan and just-in-time drift checks, sequential
   dispatch, absence verification, certainty, history, and resume.
4. **Integration**: optional scan, completions, docs, roadmap, focused end-to-end validation.

### Technology Decisions

| Decision         | Recommendation                                            | Rationale                                               |
| ---------------- | --------------------------------------------------------- | ------------------------------------------------------- |
| Delete endpoint  | Generated single-ID endpoint                              | Per-target attribution and recovery                     |
| Plan schema      | Additive strict v2 union member                           | Reuses proven safety boundary                           |
| Disk evidence    | Lidarr path/statistics only                               | Works when Lidarr is remote; avoids second authority    |
| File mode        | Safe keep-files default; explicit `--delete-files` opt-in | Prevents omission from authorizing files                |
| Import exclusion | Explicitly false for #200                                 | Not required by issue; avoids unverified extra mutation |
| Apply authority  | Separate artist and file allow flags                      | `--yes` remains prompt bypass only                      |
| Plex integration | Apply-time, one full scan, best effort                    | Stable adapter contract and failure isolation           |
| Dependencies     | None                                                      | Existing primitives cover the feature                   |

### Quick Wins

- The generated endpoint, artist impact projection, selector, plan engine, destructive scheduler,
  private artifact storage, history, resume, and Plex scan adapter already exist.
- Existing completion generators and parity tests make command-surface drift directly testable.

### Future Enhancements

- Configurable import-list exclusion with its own preview and verification contract.
- Album deletion only through issue #223.
- Path-scoped Plex refresh only if a reliable post-delete library mapping is later demonstrated.

## Risk Assessment

### Technical Risks

| Risk                                        | Likelihood | Impact   | Mitigation                                                                     |
| ------------------------------------------- | ---------- | -------- | ------------------------------------------------------------------------------ |
| Wrong or broadened cohort                   | Low        | Critical | Stable IDs, sealed selection, checksum, no apply-time filter reevaluation      |
| Unreviewed file deletion                    | Low        | Critical | Safe default plus independent file authorization                               |
| Impact changes after review                 | Medium     | Critical | Whole-plan and just-in-time exact evidence comparison                          |
| Duplicate destructive request after timeout | Medium     | Critical | Zero automatic retry, durable possible-dispatch state, targeted reconciliation |
| Existing plan compatibility regression      | Medium     | High     | Additive union, exact fixtures, focused compatibility tests                    |
| Lidarr API behavior differs                 | Low        | High     | Pinned generated contract and disposable-instance verification                 |
| Plex failure couples to deletion            | Medium     | Medium   | Post-success one-shot scan with separate result                                |
| Operational data leaks                      | Low        | Medium   | Private artifacts, sanitized output, no credentials/raw bodies                 |

### Integration Challenges

- The operation registry must represent present/absent live state without weakening existing
  operations that require a present artist.
- Initial absence must remain stale while post-dispatch absence can verify or satisfy a recorded
  attempt.
- Optional scan reporting must be additive and must not change immutable plan/history contracts.
- Review presenters and CSV projections must add deletion evidence without destabilizing existing
  operation output.

### Security Considerations

#### Critical — Hard Stops

| Finding                                     | Risk                              | Required Mitigation                                |
| ------------------------------------------- | --------------------------------- | -------------------------------------------------- |
| Destructive authority confused with `--yes` | Silent artist/file deletion       | Mandatory independent allow flags                  |
| Artifact or evidence tampering              | Different operation than reviewed | Closed schema, canonical checksum, origin binding  |
| Stale impact evidence                       | Broader file effect than reviewed | Fresh exact Lidarr evidence checks before dispatch |
| Ambiguous post-dispatch result              | Blind destructive retry           | Stop admission and reconcile by immutable ID       |

#### Warnings — Must Address

| Finding                      | Risk                        | Mitigation                                  | Alternatives                                |
| ---------------------------- | --------------------------- | ------------------------------------------- | ------------------------------------------- |
| Private paths/names in plans | Operational data disclosure | Private atomic storage and sanitized output | Hashing paths would weaken human review     |
| Terminal control text        | Spoofed review/prompt       | Existing terminal-safe projection           | Reject malformed upstream data              |
| Plex scan failure            | False rollback/replay       | Separate best-effort result                 | Omit scan if additive output cannot be safe |

#### Advisories — Best Practices

- Keep credentials least-privilege and separate between Lidarr and Plex.
- Retain sequential execution; reconsider concurrency only with an equally strong attribution model.
- Use disposable media only for any live destructive contract test.

## Task Breakdown Preview

### Phase 1: Contracts and facade

**Focus**: Establish the serialized and HTTP safety boundaries.

**Tasks**:

- Add the single-ID facade method and focused request/error tests.
- Add strict v2 delete operation, evidence, summary, risk, parsing, checksum, and compatibility
  tests.

**Parallelization**: Facade and plan-contract work can proceed independently when their public
method/type names are agreed first.

### Phase 2: Planning

**Focus**: Create mutation-free, evidence-complete plans.

**Dependencies**: Plan contracts.

**Tasks**:

- Add the artist-delete planning action with selector reuse and evidence validation.
- Extend plan and machine presenters with exact impact summaries.

### Phase 3: Destructive apply

**Focus**: Enforce authority, drift, sequential mutation, verification, and recovery.

**Dependencies**: Facade and plan contracts.

**Tasks**:

- Add present/absent classification, whole-plan and per-target evidence checks, delete dispatch,
  bounded not-found verification, uncertainty, history, and resume.
- Add cumulative authorization and prove no deferred/background replay.

### Phase 4: Integration and release

**Focus**: Complete public behavior and repository lifecycle.

**Dependencies**: Planning and apply safety.

**Tasks**:

- Add optional scan and separate reporting.
- Update command help, Bash/Zsh/Fish completions, focused tests, README, feature docs, and roadmap.
- Run package and repository validation, formal review/fix, PR, CI, merge, and cleanup.

## Decisions Needed

The design workflow resolves the implementation decisions as follows:

1. **Album scope**: Exclude; #223 owns album deletion.
2. **Import-list exclusion**: Send explicit `false`; do not expose it in #200.
3. **Missing evidence**: Fail planning in both modes for one stable schema and honest preview.
4. **Initial missing artist**: Block as stale; do not imply reviewed file deletion succeeded.
5. **Plex scan failure**: Preserve verified deletion and report an independent warning/result.
6. **Child issues**: None required.

The only implementation-time check is whether the current apply result can add optional scan status
without destabilizing existing output. If not, emit a sanitized warning and keep scan state out of
the structured deletion result rather than weakening plan/history compatibility.

## Research References

- [research-external.md](./research-external.md): pinned API and adapter contracts.
- [research-business.md](./research-business.md): user stories, rules, and success criteria.
- [research-technical.md](./research-technical.md): architecture and data models.
- [research-ux.md](./research-ux.md): CLI workflow and recovery UX.
- [research-security.md](./research-security.md): severity-classified destructive-operation risks.
- [research-practices.md](./research-practices.md): reuse, KISS, and test scope.
- [research-recommendations.md](./research-recommendations.md): resolved recommendations and task
  breakdown.
