# Feature Spec: Lidarr Artist Bulk Profile and Tag Management

## Executive Summary

Issue #199 adds safe mass assignment of existing Lidarr quality profiles, metadata profiles, and
tags through two new sealed plan producers: `artist-profiles` and `artist-tags`. Planning selects a
fresh, complete cohort and seals exact per-artist before/after state. Apply revalidates the reviewed
state, requires approval, mutates one artist per request, verifies each managed postcondition, and
records every outcome durably. The implementation writes strict version 2 plans while preserving
version 1 monitoring read, apply, history, and resume compatibility. It reuses the authenticated
generated-client facade and existing artifact, checksum, origin, claim, scheduler, and recovery
boundaries.

## External Dependencies

### APIs and Services

The feature uses only operations already present in the checked-in generated Lidarr client:

- list artists;
- get one artist by ID for immediate stale checks and verification;
- list quality profiles;
- list metadata profiles;
- list tags;
- `PUT /api/v1/artist/editor`.

The artist editor body is constructed by the private facade from an allowlist:

```text
artistIds plus qualityProfileId and/or metadataProfileId
artistIds plus tags plus explicit applyTags
```

Monitoring, root-folder movement, file movement, deletion, import-list exclusion, searches, and
other editor fields must remain unrepresentable for these operations. The implementation accepts
any successful `2xx`, including Lidarr's observed `202`, ignores the response body, and verifies
the result with a fresh read.

### Libraries

No new runtime or development dependency is required. The implementation reuses:

- the pinned `@hey-api/openapi-ts` generator and committed OpenAPI snapshot;
- Node Fetch through the existing authenticated transport;
- the existing Lidarr scheduler and `p-limit`;
- the existing safe plan/history/deferred storage;
- Commander and the existing output/rendering utilities.

Existing production dependency advisories are orthogonal to the Lidarr editor feature. They must be
tracked through the repository's security/release process and must not be hidden inside the feature
implementation.

### Compatibility assumptions

- Node.js 22 and the repository's TypeScript ESM conventions remain authoritative.
- Generated modules stay private to the Lidarr client layer.
- Existing version 1 plan bytes and checksums are immutable.
- The plan/apply workflow remains local-state oriented and uses the `local-only` scheduler lane.
- A supported Lidarr instance makes an accepted profile/tag update visible to a bounded follow-up
  read. If an immediate read cannot establish the postcondition, the result is uncertain and
  requires explicit resume.

## Business Requirements

### User Stories

Users must be able to:

1. assign an existing quality profile to many artists;
2. assign an existing metadata profile to many artists;
3. assign quality and metadata profiles together in one reviewed profile plan;
4. add an existing tag to many artists while preserving unrelated tags;
5. remove an existing tag from many artists while preserving unrelated tags;
6. replace the complete tag set for many artists;
7. explicitly clear all tags from many artists;
8. target artists by exact IDs, deterministic filters, or explicit whole-library selection;
9. preview exact before/after state before any write;
10. save a sealed plan, dry-run it against live state, apply it with approval, and resume safely
    after partial or uncertain execution.

### Command contract

Profile plans:

```bash
rfmedia lidarr plan artist-profiles [selection] \
  [--quality-profile <reference>] \
  [--metadata-profile <reference>] \
  [--max-batch <n>] [--plan-file <path>]
```

Tag plans:

```bash
rfmedia lidarr plan artist-tags [selection] \
  (--add-tag <reference>... | --remove-tag <reference>... |
   --set-tag <reference>... | --clear-tags) \
  [--max-batch <n>] [--plan-file <path>]
```

Shared selection options:

```text
--ids <comma-separated-positive-ids>
--all
--select-monitored
--select-unmonitored
--select-quality-profile <reference>
--select-metadata-profile <reference>
--select-tag <reference>
```

`--select-tag` is repeatable and uses all-of semantics. Predicate families combine with AND.

### Business Rules

Exactly one selection mode is required:

1. `--ids` selects unique, known positive artist IDs;
2. one or more `--select-*` filters select from the complete fresh artist list;
3. `--all` explicitly considers the complete library.

IDs, filters, and `--all` are mutually exclusive. Missing selectors never imply the whole library.
Planning resolves the complete matched cohort before checking its cap; it never pages, truncates,
or authorizes from stale cache. The default cap remains 25 and the hard maximum remains 1,000.
Zero matches fail without writing a plan. A non-empty all-no-op cohort succeeds and produces an
auditable plan.

### Resource reference rules

Profile and tag references use this deterministic syntax:

- a positive decimal string means a numeric resource ID;
- other text means a trimmed, case-insensitive exact name or label;
- `name:<value>` forces name interpretation, including numeric names.

Resolution uses fresh bounded resource lists. Unknown and ambiguous references fail with bounded
valid `name (id)` choices. The stable numeric ID is authoritative; the server-provided label is
review context. A referenced resource deleted before apply blocks all writes. A rename of the same
ID updates display context and warns without redirecting intent.

The feature does not create tags implicitly. It does not simulate profile clearing with `0`,
`null`, or an omitted editor field.

### Preview and approval

Planning and apply dry-run show:

- canonical Lidarr origin, plan ID, checksum, operation, selector, cap, and risk;
- matched, changed, and unchanged artist counts;
- profile transition counts or tag added, retained, and removed counts;
- artist ID/name and exact managed before/after state;
- profile and tag names plus IDs;
- every tag assignment removed by set or clear;
- an explicit all-no-op result.

Human output shows the first 20 entries by default and states how many were omitted.
The existing global `--verbose` mode shows all entries. Artifacts and JSON/YAML/CSV output always
retain the complete bounded cohort.

Interactive apply performs a live dry-run before a default-no confirmation. Non-interactive and
machine-output apply requires `--yes`. Tag set and clear additionally require a purpose-specific
`--allow-tag-replacement` authorization outside the interactive confirmation flow.

### Completion criteria

The issue is complete only when:

- all profile and tag modes work through sealed plans;
- dry-run is mutation-free and history-free;
- apply verifies every write and supports safe resume;
- version 1 compatibility and version 2 strictness are tested;
- Bash, Zsh, and Fish completions are updated and parity-tested;
- CLI and feature documentation plus `ROADMAP.md` are updated;
- generated-client drift and architecture gates pass;
- local validation and GitHub CI pass;
- the issue-closing PR is reviewed, fixed as needed, squash-merged, and the issue is closed.

## Technical Specifications

### Architecture boundaries

The implementation preserves these ownership rules:

- `src/lib/lidarr/client.ts` owns generated imports, runtime wire projection, minimal editor
  request construction, and transport errors.
- A pure artist-selection module owns selector validation, reference resolution, AND/all-of
  filtering, deterministic sorting, caps, and tag set algebra.
- Operation definitions own entry construction, canonical operation state, risk, change
  detection, stale classification, idempotency, execution, deferred payload validation, and replay
  matching.
- The plan engine owns strict versioned schemas, canonical checksums, safe artifact I/O, history,
  resume selection, and exclusive claims.
- Actions own fresh orchestration and plan/apply lifecycle.
- Commands own Commander grammar, help, rendering, approval, output envelopes, and exit behavior.

No action or command may import generated Lidarr code, construct `/api/v1/` paths, call Fetch, or
accept a general editor payload.

### Stable domain and facade types

Add narrow immutable types for profiles and tags:

```ts
interface LidarrProfile {
  readonly id: number;
  readonly name: string;
}

interface LidarrTag {
  readonly id: number;
  readonly label: string;
}
```

Extend `LidarrClientApi` with intent-bearing methods for:

- listing quality profiles, metadata profiles, and tags;
- getting one artist by ID;
- assigning one artist's requested profile fields;
- applying one explicit tag mode to one artist.

Runtime projectors validate positive safe integer IDs, bounded non-empty labels, response counts,
and normalized artist tag arrays. Malformed resources reject the whole response.

The resilience wrapper must delegate every new method. Mutation-authorizing reads use fresh data
with retry overrides appropriate to planning/apply and no stale fallback. Mutations remain outside
automatic in-place retry allowlists.

### Versioned plan model

Keep the current exact version 1 parser, checksum representation, monitoring operation behavior,
history identity, and resume behavior.

Add `rfmedia.lidarr-plan.v2` as a strict discriminated union for:

- artist monitoring;
- artist profile assignment;
- artist tag mutation.

All current producers, including monitoring, write version 2. Readers dispatch strictly by version
and reject unknown versions, operations, entry shapes, keys, sensitive keys, prototype keys, and
inconsistent operation/entry/risk combinations.

Version 2 contains a canonical selection object and operation-specific entries. The checksum
covers:

- target origin;
- normalized selection context;
- operation and requested modes;
- resolved IDs and labels;
- cap;
- every before/after value and tag delta;
- risk and cascade facts;
- target order;
- idempotency keys.

Tag arrays are sorted, unique sets in construction, checksums, comparisons, payloads, outputs, and
verification.

Existing JSONL history and deferred-intent storage require no migration. New executor names and
payloads are exact and credential-free:

```text
lidarr.artist-profile-assignment
  { artistId, qualityProfileId?, metadataProfileId? }

lidarr.artist-tag-mutation
  { artistId, mode, tagIds }
```

### Profile operation semantics

A profile plan requires at least one managed field. Each entry stores the requested dimensions and
their reviewed before/after IDs and labels.

Live classification examines only managed dimensions:

- all managed fields at desired values: `satisfied`;
- every managed field at either its reviewed-before or desired value, with at least one change
  remaining: `ready`;
- any managed field at a third value: `drifted`.

Profile assignment is medium risk because it changes future acquisition and refresh policy. The
preview must not imply existing files, queue entries, monitoring state, or searches are changed.

### Tag operation semantics

Exactly one tag mode is required:

| Mode   | Desired state                         | Lidarr wire mode          |
| ------ | ------------------------------------- | ------------------------- |
| Add    | reviewed/live set union requested set | `add`                     |
| Remove | reviewed/live set minus requested set | `remove`                  |
| Set    | exact requested set                   | `replace`                 |
| Clear  | empty set                             | `replace` with `tags: []` |

Add, remove, and set require at least one unique tag. Clear accepts no tag values and is expressed
only by `--clear-tags`. An empty set never means clear.

Entries store normalized full before/after sets and added, removed, and retained deltas.

Classification is mode-specific:

- add is satisfied when every requested tag is present; unrelated tag changes are tolerated;
- remove is satisfied when no requested tag is present; unrelated tag changes are tolerated;
- set and clear are satisfied only at the exact desired set, ready only at the exact
  reviewed-before set, and drifted at any third set.

Add and remove are low-risk, non-destructive delta operations. Set and clear are high-risk and
destructive to tag assignments. They require removal-focused preview and replacement-specific
authorization.

### Apply lifecycle

Apply performs:

1. exact schema, checksum, origin, operation, cap, entry, risk, history, and resume validation;
2. one fresh whole-plan resource and artist preflight;
3. zero-write classification of every relevant entry;
4. mutation-free, claim-free, history-free return for `--dry-run`;
5. exclusive claim acquisition and approval for real apply;
6. one targeted artist read immediately before each admission;
7. one minimal editor request with `artistIds: [id]`;
8. one fresh targeted verification read;
9. synchronous durable outcome recording before the next admission.

Initial missing resources or stale artists block the whole run before any write.
Late drift, lost claim, cancellation after dispatch, or an unreconciled outcome stops later
admissions. A retryable pre-write failure may be deferred. A post-dispatch outcome is never called a
definite failure without reconciliation; it becomes verified success, safely classified failure,
or uncertain. `--resume` rereads live state before retrying and replays only an exact operation,
payload, and idempotency-key match.

### Output and error contracts

Machine modes emit exactly one document to stdout. Human review, diagnostics, and progress remain
on stderr. Operation-specific results preserve before, after, and observed evidence where
available.

Errors use stable codes and identify:

- stage and operation;
- plan ID/checksum where safe;
- affected artist IDs;
- whether a request was dispatched;
- whether verification completed;
- retryability and safe next command.

Untrusted artist, profile, and tag labels are bounded and rejected if they contain terminal,
control, or bidirectional formatting characters. CSV output neutralizes formula-leading cells.
Credentials, headers, raw response bodies, and credential-bearing URLs never enter plans, history,
deferred payloads, logs, or output.

### Architecture and codegen gates

Validation must prove:

- generated operations remain private to the stable client;
- one production authenticated Fetch owner remains;
- no handwritten `/api/v1/` endpoint appears;
- profile/tag editor request bodies cannot contain destructive or unrelated fields;
- required generated contracts exist and offline codegen drift passes;
- new mutation call sites are confined to registered operation owners.

## UX Considerations

### User Workflows

The `select-` option prefix visually separates targeting from desired changes. Help groups options
under selection, desired changes, safety, connection, and output, with complete examples for:

- quality profile assignment;
- metadata profile assignment;
- combined profile assignment;
- tag add;
- tag remove;
- tag set;
- tag clear;
- dry-run and resume.

A bare plan subcommand prints concise help and makes no network call.

### Review clarity

Human output uses explicit words such as `CHANGE`, `NO-OP`, `REMOVE`, and `BLOCKED`; color is
supplemental. Names are always paired with stable IDs. Narrow or non-TTY output remains append-only
and understandable without cursor control or Unicode-only state indicators.

Set and clear previews emphasize the number and identity of assignments removed. Confirmation text
repeats the destructive tag-replacement intent and target count.

### Automation

Scripts can use exact numeric references, `--plan-file`, machine output, expected plan
ID/checksum, `--dry-run`, `--yes`, and `--resume`. Machine mode never prompts. Static shell
completion does not contact Lidarr or expose credentials.

Zero matches is an actionable error. All-no-op is a successful converged result with a sealed
artifact and no editor calls.

### Recovery

Every partial, deferred, stale, cancelled, or uncertain result prints a copy-pasteable safe next
step. Blind replay of a lost-response mutation is never recommended. Resume reconciles live state
and distinguishes satisfied, ready, drifted, and unresolved entries.

## Recommendations

### Implementation

1. Two plan producers with no direct write path.
2. Strict version 2 plans with immutable version 1 compatibility.
3. Explicit IDs, filters, or `--all` selection from fresh complete state.
4. Quality, metadata, and combined profile assignment.
5. Tag add, remove, set, and explicit clear, one mode per plan.
6. Exact resource resolution with ambiguity failure and stable ID authority.
7. Complete before/after artifacts and machine output plus bounded human previews.
8. Mutation-free dry-run and approval-gated apply.
9. Whole-plan preflight, per-target revalidation, one-ID editor calls, and post-write verification.
10. Durable per-target outcomes, uncertain-state admission stops, and exact resume matching.
11. Architecture/codegen enforcement, focused and regression tests, all three shell completions,
    documentation, and `ROADMAP.md`.

### Technology Follow-ups

- read-only profile and tag discovery commands;
- a local plan renderer;
- performance measurements at 25, 100, and 1,000 artists;
- a separately named any-tag selector if real demand appears;
- dependency remediation through a dedicated security issue and release gate.

### Explicitly Out of Scope

- implicit tag creation;
- profile clearing unsupported by Lidarr;
- IDs-plus-filters intersections;
- free-form selector expressions;
- combined profile-and-tag plans;
- multi-ID editor requests;
- automatic rollback;
- automatic background replay;
- transferable signed plans;
- a new runtime SDK, schema library, job runner, or database table.

## Risk Assessment

| Risk                                                            | Level  | Required treatment                                                                                    |
| --------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| Missing, paged, or truncated selection targets the wrong cohort | High   | Exactly one explicit mode, fresh complete state, no truncation, preserved caps, frozen sorted IDs     |
| Tag set/clear removes unrelated policy tags                     | High   | Explicit modes, full removals preview, exact stale checks, destructive risk, extra authorization      |
| Post-dispatch timeout follows a committed write                 | High   | One-ID desired-state calls, targeted reconciliation, uncertain state, stop admission, explicit resume |
| Resource ambiguity redirects intent                             | High   | Decimal/`name:` syntax, exact matching, duplicate failure, stable ID authority                        |
| SHA-256 is mistaken for author authentication                   | Medium | Private safe I/O, origin binding, checksum pinning, accurate terminology                              |
| Profile changes alter future acquisition policy                 | Medium | Old/new profile preview, cascade explanation, no claims of file/queue changes                         |
| Resource deletion or concurrent managed-state change            | Medium | Whole-plan preflight, immediate read, fail closed before unsafe writes                                |
| Editor `202` and OpenAPI response mismatch                      | Medium | Accept successful 2xx, discard body, independently verify                                             |
| Per-target full-library reads amplify load                      | Medium | Add generated targeted read, keep one whole-list preflight, preserve caps                             |
| Plans disclose operational metadata                             | Medium | Mode `0600`, private retention guidance, no credentials or raw responses                              |
| Existing vulnerable dependencies affect release posture         | Medium | Track independently, apply repository release gate, add no new dependency                             |

No critical issue is introduced if the existing authenticated facade, origin validation, sealed
plan/apply, approval, claim, history, and resume boundaries are preserved.

### Security Considerations

The plan checksum is an integrity seal, not an author signature. Private owner-only storage,
no-follow and atomic file I/O, canonical-origin binding, explicit approval, and expected
ID/checksum pinning preserve the current single-user trust boundary. Credentials, request headers,
raw response bodies, and credential-bearing URLs never enter artifacts, history, deferred intents,
logs, or machine output.

### Technical Risks

The main implementation risks are strict schema evolution, preserving version 1 resume identity,
targeted verification availability, and ensuring operation-specific stale semantics remain behind
the shared apply lifecycle. Focused contract tests, architecture gates, codegen drift checks, and
full regression validation are release requirements.

## Task Breakdown Preview

| Task | Scope                                                                                                            | Dependencies    |
| ---- | ---------------------------------------------------------------------------------------------------------------- | --------------- |
| T1   | Preserve v1 and add strict v2 plan, entry, result, checksum, and validation contracts                            | None            |
| T2   | Add bounded profile/tag projections, resource reads, targeted artist read, and minimal facade mutations          | None            |
| T3   | Add pure selection, reference resolution, deterministic filters, caps, and tag algebra                           | T2 domain types |
| T4   | Add profile/tag operation definitions and plan producers; move monitoring producer to v2                         | T1-T3           |
| T5   | Extend generic apply with resource preflight, targeted checks, verification, observed evidence, and exact resume | T1, T2, T4      |
| T6   | Add CLI grammar, rendering, replacement approval, docs, and Bash/Zsh/Fish completion parity                      | T4-T5           |
| T7   | Extend architecture and codegen gates                                                                            | T2, T4          |
| T8   | Update package docs, feature docs, changelog if required, and `ROADMAP.md`                                       | T1-T7           |
| T9   | Run focused, package, architecture, codegen, markdown, and integration/regression validation                     | T1-T8           |

T1 and T2 may proceed in parallel. T3 follows the domain contract. T4 is the convergence point;
apply and presentation work follow it. Tests are written with their owning tasks, then T9 provides
release evidence.

## Decisions Needed

The research workflow resolves the implementation defaults below. They are not blockers unless
the maintainer explicitly overrides them:

1. use separate `artist-profiles` and `artist-tags` plan leaves;
2. allow quality and metadata profiles together;
3. write strict version 2 plans and preserve version 1 read/apply/resume behavior;
4. use mutually exclusive IDs, filters, or `--all`;
5. use AND filter semantics and all-of repeated tag filters;
6. use decimal IDs, exact case-insensitive names, and `name:` forcing;
7. ship add, remove, set, and explicit clear now;
8. require extra non-interactive authorization for set/clear;
9. issue one editor request per artist;
10. accept any successful `2xx` and ignore its body;
11. verify every accepted write with a targeted fresh read;
12. show 20 human rows by default and all rows under `--verbose`;
13. fail on zero matches and preserve auditable all-no-op plans;
14. classify profiles medium risk, tag deltas low risk, and tag replacement high risk;
15. keep core #199 behavior together and track dependency remediation separately if repository
    policy requires it.

Implementation-time evidence must determine whether supported Lidarr versions require a small,
bounded post-write reconciliation delay and whether the existing CSV layer already neutralizes all
formula-leading labels.

## Research References

- [External API and ecosystem research](./research-external.md)
- [Business and product research](./research-business.md)
- [Technical architecture research](./research-technical.md)
- [UX and accessibility research](./research-ux.md)
- [Security research](./research-security.md)
- [Engineering practices research](./research-practices.md)
- [Synthesized recommendations](./research-recommendations.md)

Primary external references, pinned source commits, confidence levels, and freshness notes are
recorded in the research artifacts above. The repository's checked-in OpenAPI snapshot and
generated-client drift checks remain the implementation-time source of truth.
