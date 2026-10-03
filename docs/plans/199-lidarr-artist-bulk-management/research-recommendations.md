# Recommendations — Lidarr Artist Bulk Profile and Tag Management

## Executive Summary

Issue #199 should ship as two new producers inside the existing sealed
`lidarr plan` / `lidarr apply` workflow:

```text
lidarr plan artist-profiles
lidarr plan artist-tags
```

`artist-profiles` assigns an existing quality profile, metadata profile, or
both. `artist-tags` performs exactly one explicit tag operation: `add`,
`remove`, `set`, or `clear`. The two operations remain separate because their
risk, stale-state, retry, and preview semantics differ. The issue must not add
a direct mutation command or the originally proposed standalone editor path.

Both commands select from a fresh complete artist snapshot, resolve existing
resources to stable IDs, show and seal exact per-artist before/after state, and
write a version 2 plan. Existing version 1 monitoring plans remain readable and
applicable. Apply performs a zero-write whole-plan preflight, then executes one
artist ID per editor request, verifies the managed postcondition with a fresh
read, and durably records the outcome before admitting the next artist.

The first release should support three mutually exclusive selection modes:
exact IDs, AND-composed filters, or explicit `--all`. Repeated tag filters use
all-of semantics. This is easier to teach and audit than mixing IDs and
filters, while still satisfying the issue's targeted filter/tag selection
scope. Selection is never paged, truncated, inferred from omitted options, or
authorized from stale cache.

The recommendations synthesize the
[external](research-external.md),
[business](research-business.md),
[technical](research-technical.md),
[UX](research-ux.md),
[security](research-security.md), and
[practices](research-practices.md) findings. The implementation notes in the
original issue predate the shipped plan/apply architecture; the issue's
required quality-profile, metadata-profile, tag, selector, and preview behavior
remains in scope, but its proposed file layout should not be treated as an
architectural constraint.

## Implementation Recommendations

### 1. Extend the existing plan/apply boundary

- Add `lidarr plan artist-profiles` and `lidarr plan artist-tags`; keep
  `lidarr apply <plan-file>` unchanged as the only write entry point.
- Use separate operation kinds:
  `artist-profile-assignment` and `artist-tag-mutation`.
- Allow quality and metadata profiles to be assigned together in one profile
  plan. Classification considers only the requested dimensions and permits
  safe partial convergence.
- Do not combine profile and tag changes in one plan. A combined optional-field
  patch makes risk, stale checks, partial failure, and recovery unnecessarily
  ambiguous.
- Drop the proposed `lib/lidarr/editor.ts`. Generated endpoint imports remain
  private to `lib/lidarr/client.ts`; actions orchestrate plans and never own a
  second transport or direct mutation path.

Recommended command contract:

```bash
rfmedia lidarr plan artist-profiles [selection] \
  [--quality-profile <reference>] \
  [--metadata-profile <reference>] \
  [--max-batch <n>] [--plan-file <path>]

rfmedia lidarr plan artist-tags [selection] \
  (--add-tag <reference>... | --remove-tag <reference>... |
   --set-tag <reference>... | --clear-tags) \
  [--max-batch <n>] [--plan-file <path>]
```

Shared selection options:

```text
--ids <comma-separated-positive-ids>
--all
--select-monitored | --select-unmonitored
--select-quality-profile <reference>
--select-metadata-profile <reference>
--select-tag <reference>             repeatable, all-of
```

The `select-` prefix keeps targeting visibly distinct from desired changes.
Commander should enforce simple conflicts, and action-level validation should
repeat every invariant for non-CLI callers.

### 2. Make resource references usable and unambiguous

- Accept positive decimal input as a resource ID.
- Accept other input as a trimmed, case-insensitive exact name or label.
- Support `name:<value>` to force name interpretation, including a resource
  literally named with decimal digits.
- Do not fuzzy match, select the first duplicate, or implicitly create a tag.
- Resolve from fresh bounded lists and require exactly one match. On failure,
  print bounded valid `name (id)` choices.
- Store the resolved numeric ID as authority and the server-returned name or
  label as review context.
- Treat deletion of a referenced desired resource as a preflight blocker. A
  rename of the same ID is a warning and updated display context, not a
  redirection or stale-state failure.

Profile clearing is not supported by Lidarr's current validated contract and
must not be simulated with `0`, `null`, or omission. A profile plan requires at
least one desired profile.

### 3. Use explicit, deterministic selector semantics

Require exactly one selection mode:

1. **Exact IDs:** `--ids` supplies unique positive artist IDs. Duplicate or
   unknown IDs fail planning.
2. **Filters:** one or more `--select-*` predicates select from the complete
   live artist list. Predicate families combine with AND; repeated
   `--select-tag` means the artist contains every requested tag.
3. **Whole library:** `--all` is exclusive with every other selector and makes
   blast radius explicit.

Do not allow `--ids` plus filters in the first release. The intersection model
is defensible, but excluded-ID reporting and mixed candidate/predicate
semantics add complexity without being required for issue #199. A user can
express an exact cohort with IDs or a reproducible cohort with filters.

Additional invariants:

- Planning uses fresh state with stale fallback disabled and does not reuse
  `lidarr list` pagination or its default limit.
- Resolve the complete matched set before comparing it to `maxBatch`; never
  truncate.
- Keep default `maxBatch` 25, hard maximum 1,000, and deterministic ascending
  artist-ID order.
- Zero matches fail without writing a plan. A non-empty all-no-op cohort
  succeeds and writes an auditable plan whose entries apply as `satisfied`.
- Freeze the exact artist IDs in the artifact. Apply never reruns selectors to
  broaden or shrink the cohort.
- Selection tags are evaluated from the planning snapshot, so selecting by a
  tag and then removing or replacing it is well-defined.

The initial filter set must include monitored state, quality profile, metadata
profile, and all-of tags. Artist name, path, genre, date, and statistics
expressions are not required for this issue.

### 4. Ship all required tag behaviors with one mode per plan

Exactly one tag mode is required:

| Plan mode | Desired-state calculation        | Wire mode                 |
| --------- | -------------------------------- | ------------------------- |
| `add`     | `after = before union requested` | `add`                     |
| `remove`  | `after = before minus requested` | `remove`                  |
| `set`     | `after = requested`              | `replace`                 |
| `clear`   | `after = empty set`              | `replace` with `tags: []` |

- `add`, `remove`, and `set` require at least one unique tag.
- `clear` accepts no tag values and must be spelled `--clear-tags`.
- An empty `set` never means clear.
- Add/remove/set/clear are mutually exclusive. Combining add and remove in one
  plan would require two remote operations per artist and introduce an
  avoidable partial-failure boundary.
- Persist normalized, sorted, unique full before/after tag sets and
  added/removed/retained deltas in each entry.
- Always send explicit `applyTags`; never rely on the server default.
- Resolve existing tags only. Tag creation is a separate remote state
  transition and is not hidden inside planning.

Stale classification is mode-specific:

- `add` is satisfied when every requested tag is present; otherwise it remains
  ready. Unrelated tag changes do not conflict.
- `remove` is satisfied when no requested tag is present; otherwise it remains
  ready. Unrelated tag changes do not conflict.
- `set` and `clear` are satisfied only at the exact desired set, ready only at
  the exact reviewed-before set, and stale at any third set because replacement
  would overwrite a concurrent edit.

Tag add/remove plans are low risk and non-destructive. Tag set/clear plans are
high risk and destructive with respect to tag assignments, although they do
not delete artists or files. Set/clear preview and approval must prominently
show every tag assignment that will be removed. Interactive approval should
repeat the replacement count and intent; non-interactive execution requires
both `--yes` and a purpose-specific `--allow-tag-replacement`.

### 5. Introduce plan schema v2 and preserve v1 compatibility

Add `rfmedia.lidarr-plan.v2` rather than silently broadening the meaning of v1.
The plan reader dispatches strictly by version:

- Preserve the current exact v1 parser, checksum representation, operation
  allowlist, and apply behavior so existing monitoring plans and their history
  remain resumable.
- Define v2 as an exact discriminated union covering monitoring, profile
  assignment, and tag mutation.
- Have all plan producers, including artist monitoring, write v2 after this
  change so there is one current schema.
- Never rewrite a v1 artifact to v2; its original bytes/checksum identify its
  apply history.
- Reject unknown versions, operation kinds, entry shapes, and keys. Do not add
  permissive forward compatibility.

V2 adds a canonical selection object and operation-discriminated entries. Its
checksum covers the target origin, selection, operation, resolved resource IDs
and labels, cap, every before/after value, tag delta, risk, and idempotency key.
Names remain review context; IDs and exact state drive authority.

Profile entries represent an unmanaged dimension explicitly in the operation,
but must not confuse unmanaged with a nullable Lidarr profile. Tag arrays are
sorted sets everywhere: plan construction, checksum, comparisons, payloads,
machine output, and verification.

Existing JSONL apply history and the opaque deferred-intent table need no
database migration. Register exact executor names and exact payloads:

```text
lidarr.artist-profile-assignment
  { artistId, qualityProfileId, metadataProfileId }

lidarr.artist-tag-mutation
  { artistId, mode, tagIds }
```

Deferred payloads contain IDs and wire mode only, never display labels,
credentials, generated DTOs, or response bodies. Resume requires exact
operation, payload, and idempotency-key agreement.

### 6. Extend the stable Lidarr facade narrowly

Add narrow runtime-validated reads for quality profiles, metadata profiles,
tags, and one artist by ID. Add intent-bearing mutations for profile assignment
and tag update. Do not expose the generated `ArtistEditorResource` or a generic
`editArtist(payload)` method above the private client.

The facade constructs allowlisted bodies containing only:

```text
artistIds plus qualityProfileId and/or metadataProfileId
artistIds plus tags plus explicit applyTags
```

It must make monitoring, root-folder movement, file deletion,
import-list-exclusion, and other editor fields unrepresentable for these
operations. Runtime projectors require bounded, positive safe integer IDs and
bounded non-empty labels; malformed responses fail as invalid responses rather
than being partially accepted.

Use the checked-in generated operations and existing authenticated transport.
Do not add a runtime SDK, handwritten `/api/v1/` path, another Fetch owner, or
query-string authentication. Forward every new method through the resilience
wrapper, but do not cache mutation-authorizing reads or put mutations on an
in-place retry allowlist.

### 7. Preserve per-target durable execution and verify every write

The first release should call the bulk editor with one `artistIds: [id]`
request per changed entry. "Bulk" refers to the reviewed cohort and workflow,
not one shared HTTP transaction. This preserves exact late-stale checks,
idempotency, durable per-target history, deferred intent, cancellation, and
resume behavior.

Apply sequence:

1. Strictly validate version, checksum, origin, operation, selection context,
   cap, entries, risk, and prior history.
2. Freshly resolve all referenced resources and all pending artists. Report
   every missing or stale item and perform zero writes if initial preflight
   fails.
3. In `--dry-run`, return `would-apply`, `satisfied`, `blocked-stale`, and
   `skipped-resume` classifications without claims, history, deferred intents,
   or editor calls.
4. For real apply, obtain the exclusive plan claim and require the established
   approval gate plus replacement-specific authorization when applicable.
5. Read the individual artist immediately before admission and classify only
   operation-managed state.
6. Send one minimal editor request. Accept any valid successful `2xx`,
   including Lidarr's actual `202`, but ignore its response body.
7. Freshly read the individual artist again and verify the managed
   postcondition before recording success.
8. Persist the authoritative outcome synchronously before admitting the next
   artist.

Profile verification requires every managed profile ID to equal the desired
ID. Add/remove verification checks the requested delta while tolerating
unrelated tags; set/clear verification requires exact full-set equality.

If the verification read observes a definite undesired state, record a safe
postcondition failure and stop later admissions. If the response or
verification outcome cannot be reconciled after request dispatch, record
`uncertain`, stop later admissions, and require explicit `--resume`. A retryable
failure before a confirmed mutation remains `deferred`; non-retryable isolated
target failures may continue under the existing engine policy. Health, startup,
and unrelated commands never replay deferred work.

Prefer the generated single-artist read for immediate checks and verification
to avoid repeatedly downloading the full library. Keep the whole-list read for
initial preflight. Do not introduce multi-ID writes until history can represent
per-member acceptance, missing response members, partial commits, and
crash-safe reconciliation.

### 8. Make preview and output complete but usable

Planning is itself a read-only preview and must show:

- canonical Lidarr origin, plan ID/checksum, operation, normalized selector,
  `maxBatch`, and risk;
- matched, changed, and unchanged artist counts;
- grouped profile transitions or tag added/retained/removed counts;
- artist ID/name and exact managed before/after state;
- profile/tag names and IDs;
- set/clear assignments that will be removed;
- all-no-op state explicitly.

`lidarr apply --dry-run` repeats the review against fresh state and reports live
classifications. It performs no mutation and writes no apply state.

Human output should show the first 20 entries by default, state the omitted
count, and use the existing global `--verbose` mode to show every entry.
Artifacts and JSON/YAML/CSV output always retain the complete bounded cohort.
Machine mode emits exactly one document to stdout; diagnostics and progress
remain on stderr. Apply entry results include operation-specific `before`,
`after`, and, when available, `observed` evidence.

Use explicit words such as `CHANGE`, `NO-OP`, `REMOVE`, and `BLOCKED`; color is
supplemental only. Preserve plain append-only non-TTY output, terminal-control
validation, `NO_COLOR` behavior, and CSV formula neutralization for untrusted
artist/profile/tag labels. Update Bash, Zsh, and Fish completion templates and
parity tests together; completions remain static and make no remote requests.

### 9. Keep architecture and validation ownership clear

- Private client: generated operations, request bodies, response projection,
  and transport errors.
- Pure selection module: selector validation, exact resource resolution,
  filters, sorting, caps, and tag set algebra.
- Operation definitions: entry construction, canonical operation state, risk,
  change detection, stale classification, idempotency, execution, deferred
  payload validation, and replay matching.
- Plan engine: strict versioned schema, canonical serialization/checksum, safe
  artifact I/O, claims, history, and resume selection.
- Actions: fresh orchestration and artifact creation/apply lifecycle.
- Commands: grammar, help, rendering, approval, structured output, and exit
  behavior.

Generalize only the seams required by monitoring, profiles, and tags. Do not
build a plugin registry, schema DSL, universal editor, new job runner, new
database table, or rollback framework.

## Improvement Ideas

### Quick wins in the issue

1. Print bounded valid profile/tag names and IDs on resolution errors so users
   can recover without another tool.
2. Reuse the extracted pure selector predicate for consistent monitored,
   profile, and all-of tag semantics, while keeping mutation selection separate
   from the paged/stale-capable list action.
3. Add exact negative facade tests proving file move/delete/search-related
   editor fields are absent.
4. Make editor operations required generated-client contracts so a future
   OpenAPI refresh cannot silently remove them.
5. Extend the architecture audit to reject direct mutation calls outside the
   stable facade and registered operation owner.
6. Add copy-pasteable next steps after plan, no-op, partial, uncertain, and
   stale outcomes.

### Follow-up improvements

- Add read-only `lidarr profiles list` and `lidarr tags list` commands. They are
  useful discovery surfaces but not prerequisites when plan-time errors list
  bounded valid choices.
- Add a local-only `lidarr plan show <file>` renderer for reviewing a sealed
  artifact without contacting Lidarr.
- Consider a separately named `--select-any-tag` only after real demand; keep
  repeated `--select-tag` all-of and unambiguous.
- Measure planning/apply at 25, 100, and 1,000 artists and optimize targeted
  reads or bounded verification only if evidence warrants it.
- Consider multi-ID editor batching only with a durable per-member outcome and
  uncertain-batch recovery design.
- Consider authenticated plan signatures only if plans become transferable
  across users or hosts. SHA-256 plus private local storage is appropriate for
  the current single-user trust boundary.
- Consider a detailed-exit-code mode for automation after preserving the
  repository's current global exit-code contract.

### Child-issue recommendation

Keep quality profiles, metadata profiles, all four tag modes, required
selectors, preview, apply verification, and completion/documentation parity in
issue #199; splitting any of them would leave the requested feature
incomplete.

Create one linked security child issue for the existing vulnerable production
dependency set identified by the security review (`js-yaml`,
`music-metadata`/`file-type`, `picomatch`, and `ws`). This remediation is
release-relevant but orthogonal to the Lidarr editor design and needs broader
compatibility testing. Treat it as a release gate according to the
repository's audit policy, not as a reason to mix dependency upgrades into the
feature implementation commit.

Optional discovery commands, multi-ID batching, plan signing, broader
selectors, and detailed exit codes should be independent follow-up issues, not
conditions for closing #199.

## Risk Assessment

### Security findings

No critical vulnerability is introduced if the feature remains exclusively
inside the current plan/apply, facade, origin, approval, claim, and durable
history boundaries.

| ID  | Severity | Risk                                                                                  | Required mitigation / ship gate                                                                                                                                                           |
| --- | -------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | Warning  | Omitted, paged, or truncated selection causes unintended mass mutation.               | Require one explicit selection mode; use fresh complete state; preserve 25/1,000 caps; freeze sorted targets; fail rather than truncate.                                                  |
| W2  | Warning  | Tag set/clear erases unrelated policy tags.                                           | Explicit mutually exclusive set/clear; empty set cannot imply clear; show removals; exact full-set stale check; replacement-specific approval.                                            |
| W3  | Warning  | SHA-256 detects editing but does not authenticate the plan author.                    | Preserve private `0600` storage, safe no-follow/atomic I/O, origin binding, checksum coverage, approval, and optional expected ID/checksum pinning. Do not call the checksum a signature. |
| W4  | Warning  | Numeric names or duplicate normalized names redirect profile/tag intent.              | Decimal means ID, `name:` forces a name, exact case-normalized matching, ambiguity failure, ID authority, and fresh resolution.                                                           |
| W5  | Warning  | Timeout/cancellation after dispatch may follow a committed mutation.                  | One idempotent artist request; immediate reconciliation; uncertain outcome and admission stop when unresolved; explicit resume only.                                                      |
| W6  | Warning  | Per-target full-library reads amplify load up to the 1,000-entry cap.                 | Whole-list preflight plus targeted single-artist revalidation/verification; sequential admission; bounded responses and domain counts.                                                    |
| W7  | Warning  | Existing production dependencies have availability advisories.                        | Track a linked security child issue, upgrade patched versions, run the full compatibility suite, and enforce the repository's release audit policy. Add no new SDK.                       |
| A1  | Advisory | CLI API-key overrides may leak through process arguments or shell history.            | Prefer environment, dotenvx, or 1Password configuration; never log or persist the value.                                                                                                  |
| A2  | Advisory | Non-TLS remote origins expose bearer-equivalent API keys.                             | Recommend HTTPS outside trusted loopback/container networks; preserve origin validation, header-only auth, certificate validation, and redirect rejection.                                |
| A3  | Advisory | Plans/output reveal artist names, tags, profiles, host/user/cwd, and internal origin. | Treat artifacts as private operational data; retain private permissions and document retention/sharing expectations.                                                                      |

Additional data-protection gates:

- Reject sensitive/prototype keys recursively in every new artifact and
  deferred payload shape.
- Never persist API keys, auth headers, credential-bearing URLs, raw generated
  responses, or arbitrary response bodies.
- Bound array counts and label lengths, reject control/bidirectional characters
  before terminal rendering, and neutralize spreadsheet-formula prefixes in
  CSV.
- Preserve canonical same-origin validation and `redirect: "error"` before
  injecting `X-Api-Key`.
- Keep one authenticated production Fetch owner and exact allowlisted editor
  body construction.

### Product and operational risks

| Risk                                                                            | Level                               | Treatment                                                                                                                  |
| ------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Quality profile assignment changes future acquisition and upgrade behavior.     | Medium                              | Show old/new profile names and IDs plus cascade text; do not imply existing files or queue entries change.                 |
| Metadata profile assignment changes future eligible album types/release policy. | Medium                              | Show old/new metadata profile and explain future refresh/acquisition implications.                                         |
| Tag add/remove can activate tag-scoped Lidarr automation.                       | Low to medium, deployment-dependent | Explain cross-configuration tag effects; show exact delta; preserve unrelated tags.                                        |
| Tag set/clear removes assignments used by other automation.                     | High                                | Full before/after and removed list, exact stale check, destructive marker, and extra non-interactive authorization.        |
| Resource deletion between plan and apply invalidates intent.                    | Medium                              | Preflight desired IDs before any write; block the entire run and require regeneration.                                     |
| Resource rename changes review labels but not identity.                         | Low                                 | Bind stable ID, warn with current label, and do not redirect intent.                                                       |
| Editor returns `202` while OpenAPI describes unknown `200`.                     | Medium                              | Accept successful 2xx, discard body, and verify with an independent read.                                                  |
| Immediate reads may observe delayed persistence on some Lidarr versions.        | Medium                              | Contract/integration test supported versions; use a small bounded reconciliation policy before declaring uncertainty.      |
| Large plans create long runtimes and noisy output.                              | Medium                              | Default cap 25, hard cap 1,000, targeted reads, monotonic progress, 20-row text preview, full machine/artifact state.      |
| Partial execution or history-write failure misstates outcome.                   | High                                | Persist each verified result before next admission; uncertain history failure stops the run; resume reconciles live state. |

The editor payload must not move/delete files, cancel downloads, initiate
searches, change monitoring, or add import-list exclusions. Risk summaries
should state those non-effects explicitly without implying that profile/tag
policy changes are operationally harmless.

## Alternative Approaches

| Alternative                                              | Benefit                                                          | Cost / reason not selected                                                                                                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One `artist-edit` command combining profiles and tags    | Fewer commands and one apparent user intent.                     | Produces many invalid combinations and mixes profile, delta-tag, and replacement stale/risk/recovery semantics. Separate operation kinds are safer and easier to test. |
| Direct `lidarr profile` / `lidarr tag` mutation commands | Shorter interaction.                                             | Bypasses sealed review, checksum, origin binding, stale checks, approval, history, deferred intent, and resume.                                                        |
| Add new operation kinds to schema v1                     | Smaller version-dispatch change.                                 | Makes one exact version string describe incompatible operation/entry shapes. V2 with an unchanged v1 reader is honest and preserves resumability.                      |
| Reject all old v1 plans                                  | Simplifies current types.                                        | Breaks reviewed artifacts, history identity, and safe resume. Compatibility is mandatory.                                                                              |
| Allow IDs plus filters as an intersection                | Lets users guard an explicit list with current-state predicates. | Requires excluded-ID semantics and more complex selection artifacts. Mutually exclusive modes are sufficient and clearer for the first release.                        |
| Combine tag add and remove in one plan                   | Convenient tag migration syntax.                                 | Requires two editor calls or exact replacement, creating a partial-failure boundary. One mode maps directly to one idempotent server operation.                        |
| Omit set/clear until later                               | Smaller initial tag surface.                                     | Violates issue #199's tag-management intent and leaves common bulk administration incomplete. Ship them now with stronger review and authorization.                    |
| Treat empty set as clear                                 | Compact syntax.                                                  | Shell expansion or an omitted value could erase every tag. Explicit `--clear-tags` is safer.                                                                           |
| Implicitly create missing tags                           | Fewer setup steps.                                               | Hides a second resource mutation with distinct rollback, staleness, and resume behavior. Existing-only resolution is deterministic.                                    |
| Send the entire cohort in one editor request             | Fewer network calls and faster best-case execution.              | Current history cannot safely attribute partial, lost-response, or crash outcomes per artist. One-ID requests preserve evidence and recovery.                          |
| Trust the editor response body                           | Avoids a follow-up read.                                         | Pinned OpenAPI and live controller disagree, and acceptance does not prove the postcondition.                                                                          |
| Verify with a full artist-list read after every target   | Uses an already proven facade call.                              | Creates severe request amplification. Targeted reads retain per-target evidence with bounded load.                                                                     |
| Reuse `lidarr list` for selection                        | Avoids a selector helper.                                        | Its paging and stale-cache behavior are intentionally unsuitable for mutation authority.                                                                               |

## Task Breakdown Preview

The issue's original "3-5 files" estimate is no longer realistic because the
safe architecture now includes versioned plans, durable apply, multiple output
formats, architecture checks, and three completion templates. The work should
remain one coherent feature but proceed in dependency order.

| Task                                          | Scope                                                                                                                                                                     | Depends on      | Validation focus                                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| T1. Versioned plan contracts                  | Preserve v1 types/parser; add exact v2 operation, selection, entry, apply-result, stale-finding, canonicalization, and checksum contracts.                                | None            | V1 round trip/apply; v2 round trip; unknown/tampered/sensitive-key rejection; operation-entry-risk consistency.                        |
| T2. Stable facade and projection              | Add bounded profile/tag projectors, normalized artist tags, resource reads, targeted artist read, and minimal profile/tag editor methods; forward wrapper methods.        | None            | Generated method/path/body, 2xx/202 handling, aborts, malformed data, no dangerous fields, API-key isolation.                          |
| T3. Pure selection and resolution             | Implement selection modes, exact reference resolution, AND/all-of predicates, cap checks, deterministic sorting, and tag set algebra.                                     | T2 domain types | IDs/filter/all conflicts, ambiguity, numeric names, zero matches, no truncation, all tag modes, no-op behavior.                        |
| T4. Operation definitions and plan producers  | Add profile/tag registry definitions, entry construction, risk, classification, idempotency, deferred payloads, and two fresh plan actions. Move monitoring writer to v2. | T1-T3           | Partial profile convergence, tag delta drift tolerance, set/clear exact drift, deterministic checksums, zero mutation during planning. |
| T5. Generic apply and verification            | Add resource preflight, operation-owned stale detail, targeted immediate checks, post-write verification, richer observed results, and exact resume matching.             | T1, T2, T4      | Initial zero-write block, one-ID calls, satisfied no-op, late drift stop, deferred/failed/uncertain paths, cancellation, resume.       |
| T6. CLI, rendering, approval, and completions | Register both commands/options/conflicts; add operation-aware text and machine output; replacement authorization; update Bash/Zsh/Fish.                                   | T4-T5           | Help and examples, stdout/stderr separation, JSON/YAML/CSV parity, row truncation/verbose, non-TTY approval, completion parity.        |
| T7. Architecture and codegen gates            | Require generated contracts and prohibit new generated imports, endpoint strings, Fetch owners, and direct mutation call sites.                                           | T2, T4          | Positive repository audit plus intentionally failing fixtures.                                                                         |
| T8. Documentation and release evidence        | Update Lidarr plan/apply docs, generated-client docs, README, roadmap, and changelog; document risk/recovery and v1 compatibility.                                        | T1-T7           | Markdown lint, exact command examples, documented test commands and outcomes.                                                          |
| T9. Integration and regression gate           | Run focused tests, typecheck, package tests/build/lint/format/pack, generated drift checks, architecture audit, and supported-Lidarr contract tests.                      | T1-T8           | Immediate visibility after 202, profile/tag-only non-effects, full regression suite.                                                   |

T1 and T2 can proceed in parallel. T3 can start once the domain projections are
stable. T4 is the convergence point; apply and presentation work follow the
operation contract. Tests belong with each owning task rather than as a final
bulk phase, with T9 providing end-to-end release evidence.

## Key Decisions Needed

The research disagreements are resolved to the following implementation
defaults. No product decision blocks implementation unless the maintainer
explicitly overrides one of these:

1. **Command shape:** two leaves,
   `lidarr plan artist-profiles` and `lidarr plan artist-tags`; no direct
   mutation command and no combined artist-edit operation.
2. **Profile grouping:** one profile plan may set quality, metadata, or both.
3. **Plan schema:** write strict `rfmedia.lidarr-plan.v2`; retain immutable v1
   read/apply/resume compatibility; migrate the monitoring producer to v2.
4. **Selection:** exactly one of IDs, filters, or `--all`; no IDs-plus-filters
   composition in the first release.
5. **Filter logic:** AND across filter families; repeated tag filters are
   all-of; selection uses a fresh complete list and is frozen in the plan.
6. **References:** decimal means ID, other text means case-insensitive exact
   name, and `name:` forces name interpretation; ambiguity fails.
7. **Tag behavior:** ship add, remove, set, and explicit clear now; exactly one
   mode per tag plan; no implicit tag creation.
8. **Replacement safety:** set/clear are high-risk tag-assignment-destructive
   operations and require removal-focused preview plus extra non-interactive
   authorization.
9. **Execution unit:** one artist ID per editor request, with durable outcome
   before the next admission.
10. **Write success:** accept any successful 2xx but never trust the editor
    response body.
11. **Verification:** perform a targeted fresh artist read immediately after
    every accepted request; unresolved post-dispatch state is uncertain and
    stops admission.
12. **Preview/output:** plan and apply dry-run show before/after; human text
    defaults to 20 rows with `--verbose` for all; artifact and machine formats
    always contain the complete cohort.
13. **No-op behavior:** zero matches fail; all-no-op matches produce a valid
    auditable plan and apply without editor calls.
14. **Risk:** profiles are medium, tag add/remove low, tag set/clear high;
    every operation remains in the `local-only` execution lane.
15. **Child issue:** dependency vulnerability remediation is tracked
    separately but governed by the repository's release audit gate; core
    profile/tag behavior stays in #199.

## Open Questions

These questions require implementation-time or live compatibility evidence but
do not change the recommended command or safety model:

1. Which minimum Lidarr application versions are supported and included in the
   integration matrix? The OpenAPI `info.version` is not the application
   version.
2. Does the pinned generated client expose the single-artist read with the
   exact response shape needed for targeted verification? If not, add the
   narrow facade behavior using the generated supported operation or retain a
   bounded full-list fallback without weakening verification.
3. Is an accepted editor write immediately visible on every supported Lidarr
   version, or is one small bounded reconciliation delay required before
   classifying the outcome as uncertain?
4. Do integration tests confirm that profile/tag-only editor payloads enqueue
   no secondary search, file move, deletion, or audio retag work on supported
   versions?
5. Does the shared CSV formatter already neutralize formula-leading
   artist/profile/tag labels for these new projections, or must this issue add
   that protection?
6. Does the repository's release policy require the dependency-security child
   issue to merge before the #199 feature PR, or only before the next rfmedia
   release?
