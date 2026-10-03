# Lidarr Mutation Plan/Apply

`rfmedia lidarr plan` and `rfmedia lidarr apply` provide the review boundary for Lidarr writes. A
plan reads fresh state and writes a sealed JSON artifact. Apply validates that artifact, checks the
live state again, and changes only targets that still satisfy the reviewed assumptions.

Current plan producers write strict `rfmedia.lidarr-plan.v3` artifacts for artist monitoring,
album monitoring, profile assignment, tag mutation, artist deletion, artist addition, album
release-policy edits, album deletion, and track-file filtering. Each v3 artifact includes a
checksum-sealed cascade analysis derived from the canonical plan facts and the operator policy
resolved at plan time.

Existing v1/v2 artifacts remain readable and retain their original checksum, apply, history, and
resume behavior. They are never rewritten or augmented from current configuration. Because those
artifacts contain no reviewed cascade analysis, human apply output displays
`Cascade analysis: NOT RECORDED (legacy plan)` and machine output uses the explicit
`not-recorded` state.

## Sealed Cascade Analysis

Cascade analysis is a deterministic review aid for the effects a plan can establish from its
canonical entries. It runs locally while the plan is built and adds no Lidarr, Prowlarr, indexer,
provider, or download-client request. The resolved policy and result are checksum material in v3,
so preview and written-plan output use the same evidence, and apply displays the plan-time snapshot
instead of reading current configuration. The sealed `modelVersion` is
`rfmedia.lidarr-cascade.v1`.

The six metrics are:

| Metric                      | Meaning                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| `immediateIndexerQueries`   | Indexer queries directly requested by this operation; currently zero    |
| `acquisitionCandidates`     | Newly eligible acquisition candidates attributable to the reviewed plan |
| `conditionalIndexerQueries` | Possible later queries derived from acquisition candidates              |
| `newlyMonitored`            | Artists or albums newly made monitored by the reviewed changes          |
| `filesAffected`             | Exact files affected when the reviewed operation deletes files          |
| `bytesAffected`             | Exact Lidarr-reported bytes represented by those affected files         |

Every metric records five fields:

- `value`: a non-negative integer, or `null` only when the value is unknown;
- `certainty`: `exact`, `modelled`, or `unknown`;
- `horizon`: `immediate`, `conditional`, or `none`;
- `unit`: `artists`, `albums`, `indexer-queries`, `acquisition-candidates`, `files`, or `bytes`;
- `basis`: a stable derivation code rather than mutable explanatory prose.

`exact` means the value follows from sealed plan facts. `modelled` means it uses a sealed
operator-chosen numeric assumption. `unknown` means required evidence was not available and always
uses `value: null`. `immediate` describes an effect of the reviewed operation itself,
`conditional` describes possible future work if later automation or search acts on the new state,
and `none` identifies a proved absence of that effect.

Zero and unknown are deliberately different. `0` means the estimator proved that the plan exposes
no work for that metric. `null`/`UNKNOWN` means it could not calculate the quantity from reviewed
facts and configured assumptions. An omitted assumption never converts missing evidence into zero.

### Basis Codes

Basis codes state how the value was derived:

| Code                                           | Meaning                                                        |
| ---------------------------------------------- | -------------------------------------------------------------- |
| `current-operation-no-search`                  | The operation does not directly request a search               |
| `changed-artist-monitoring`                    | Derived from artists whose monitored state changes             |
| `changed-album-monitoring`                     | Derived from albums whose monitored state changes              |
| `configured-albums-per-artist`                 | Modelled with the sealed albums-per-artist assumption          |
| `operation-removes-acquisition-scope`          | The operation removes rather than exposes acquisition scope    |
| `release-automation-evidence-unavailable`      | Release/cutoff automation evidence is absent from the plan     |
| `monitored-album-file-removal`                 | File removal can expose a monitored album to later acquisition |
| `unmonitored-album-file-removal`               | File removal affects an unmonitored album                      |
| `configured-indexer-queries-per-candidate`     | Modelled with the sealed queries-per-candidate assumption      |
| `acquisition-candidates-known-zero`            | No candidates exist from which later queries could be derived  |
| `acquisition-candidates-unknown`               | Candidate count is unknown, so dependent queries are unknown   |
| `indexer-queries-per-candidate-not-configured` | Candidate count is known but its query multiplier is omitted   |
| `changed-entries`                              | Derived from canonical changed-entry evidence                  |
| `track-file-delete-candidates`                 | Derived from the sealed track-file deletion candidates         |
| `affected-file-bytes`                          | Sum of the sealed affected-file byte evidence                  |
| `no-file-impact`                               | The operation has no reviewed file effect                      |

### Operator Policy

All four fields under `lidarr.cascadeAnalysis` are optional:

```yaml
lidarr:
  cascadeAnalysis:
    # Illustrative operator policy; these values are not universal defaults.
    budgets:
      indexerQueries: 240
      acquisitionCandidates: 80
    assumptions:
      albumsPerArtist: 12
      indexerQueriesPerCandidate: 3
```

- `budgets.indexerQueries` is an advisory allowance for the plan's projected conditional indexer
  queries.
- `budgets.acquisitionCandidates` is an advisory allowance for projected acquisition candidates.
- `assumptions.albumsPerArtist` models candidate albums when a changed monitored artist lacks
  album-level plan evidence.
- `assumptions.indexerQueriesPerCandidate` models conditional queries from a known positive
  candidate count.

Configured values must be positive safe integers no greater than 1,000,000. Invalid values fail
planning before artifact creation. Omitted assumptions are sealed as `null`; omitted budgets are
sealed as `null` and assessed as `not-configured`. There are no cascade-analysis CLI flags.
Changing this configuration later does not change an existing artifact or its apply output.

These allowances are not scheduler admission limits. In particular,
`lidarr.scheduler.lanes.<lane>.operationBudget` caps how many task closures one scheduler batch
admits. `lidarr.cascadeAnalysis.budgets.*` compares estimated effects for one reviewed plan and
never changes scheduler concurrency, admission, retries, or execution.

### Allowance States and Stable Codes

Each allowance records `status`, `limit`, `projected`, and provenance
`configured-per-plan`:

| Status           | Meaning                                                              |
| ---------------- | -------------------------------------------------------------------- |
| `not-configured` | No operator allowance was configured; it does not mean unlimited     |
| `within`         | A known projection is less than or equal to the configured allowance |
| `exceeded`       | A known projection is strictly greater than the configured allowance |
| `unknown`        | An allowance exists, but the projection cannot be calculated         |

Equality is `within`. An `exceeded` or `unknown` assessment is advisory: it adds warning and
recommendation codes but is not a validation error or apply gate.

Stable warning codes are:

- `indexer-query-budget-exceeded`;
- `acquisition-budget-exceeded`;
- `budget-assessment-incomplete`.

Stable recommendation codes are:

- `reduce-scope`;
- `split-into-batches`;
- `delay-apply`.

An exceeded allowance recommends all three actions. An unknown projection against a configured
allowance recommends `reduce-scope`. Splitting or delaying may change load rate and review scope;
it does not promise to reduce total work.

### Static Evidence Boundary

The analysis is static conditional plan-time evidence. It is not:

- live Prowlarr rolling-quota usage or remaining quota;
- the number or current capacity of enabled indexers or metadata providers;
- download-client queue capacity, successful grabs, or download sizes;
- an elapsed-time or completion-time prediction;
- a scheduler lane `operationBudget`, concurrency setting, or admission decision; or
- enforcement, authorization, confirmation, retry, resume, or mutation ordering.

Apply validates and displays the sealed analysis but does not use it to block, authorize, truncate,
expand, or reorder entries. It performs no new network call for cascade analysis and does not
reinterpret a plan against current settings. Existing destructive authorization flags and `--yes`
approval remain independent.

### Cascade Output Formats

Human plan output renders `Cascade analysis` before entry rows. Apply renders
`Plan-time cascade analysis`, making the evidence age explicit. Metrics include value, unit,
certainty, horizon, and basis; allowance rows use the visible states `NOT CONFIGURED`, `WITHIN`,
`EXCEEDED`, and `UNKNOWN`. Warning and recommendation codes remain meaningful without color.
Legacy artifacts render `NOT RECORDED (legacy plan)`.

Human review and diagnostics remain on stderr. With `--output json` or `--output yaml`, stdout is
one clean command/result document. Plan output retains the complete structured value at
`result.plan.cascadeAnalysis`; apply output retains
`result.cascadeAnalysis: {status: "recorded", analysis: ...}`. Legacy apply output uses
`{status: "not-recorded"}` and does not fabricate an analysis.

CSV remains one bounded aggregate row. Its `result.cascade.*` columns include:

- `status` and `modelVersion`;
- the six metric values;
- status, limit, and projected value for each allowance;
- `highestWarningSeverity` and `highestWarningCode`; and
- JSON-encoded `warnings` and `recommendations`.

CSV uses `result.cascade.status=not-recorded` and empty cascade detail columns for legacy plans.
Machine output retains the complete bounded cohort and never mixes human diagnostics into stdout.

## Create an Artist Add Plan from Discovery

Discovery is read-only by default. Select one or more visible MBID-backed recommendations and
provide the required Lidarr resources to create one plan:

```bash
rfmedia lidarr discover \
  --artist "Radiohead" \
  --max-add 3 \
  --add 1,4,7 \
  --root-folder "/music" \
  --quality-profile "Lossless" \
  --monitored \
  --unmonitor-types singles,eps \
  --plan-file ./artist-add.json
```

`--add` accepts unique comma-separated visible ranks from 1 through 100. Their count cannot exceed
`--max-add`, whose default is 1 and hard maximum is 25. All selected ranks and canonical MBIDs are
validated before I/O. The handoff resolves the shared root folder and quality profile once, then
reads every exact MBID from fresh Lidarr state.

`--metadata-profile` is optional. When omitted, planning uses the selected root folder's default
only if structural server evidence shows that it allows exactly the primary type `Album` and no
secondary type. Otherwise planning uses the unique metadata profile with that structural
albums-only policy. Zero or multiple eligible profiles fail closed and require an explicit
`--metadata-profile`; a profile name alone is not safety evidence.

Planning is atomic: any invalid rank, MBID-less candidate, ambiguous lookup, or unresolved resource
writes no artifact. Selected artists already present are reported per rank and excluded from
mutation entries. If all are present, no artifact is written. Otherwise one origin-bound,
checksum-protected artifact contains every addable entry in visible-rank order, carries independent
discovery provenance per entry, and seals `maxBatch` to the addable entry count. One discovery
invocation never emits several plan files.

The reviewed operation records expected absence. Omitting `--monitored` seals `monitored: false`;
the positive-only `--monitored` override seals `monitored: true`. Every new plan still seals
`monitorNewItems: "none"` and `searchForMissingAlbums: false`; new-item monitoring and missing-album
search cannot be enabled at apply.

`--unmonitor-types <types>` optionally seals post-add album normalization. It accepts the canonical
closed selectors `albums`, `eps`, `singles`, `broadcasts`, `others`, `compilations`, `live`,
`remixes`, `soundtracks`, `demos`, and `mixtapes`. Parsing lowercases and trims tokens, converts
singular aliases to canonical plural forms, rejects canonical duplicates, sorts the result, and
seals it in the checksummed operation and entries. Omission seals an empty selector list.

`discover --add` never sends an artist-create request and does not accept `--yes`. Rank selection
approves plan membership only. Use `rfmedia lidarr apply ./artist-add.json --dry-run` to check the
complete artifact and live expected absence, then approve mutation separately through interactive
apply or explicit `rfmedia lidarr apply ./artist-add.json --yes`. Machine output and
non-interactive stdin require `--yes`. See
[Lidarr Similar-Artist Discovery](lidarr-discovery.md) for the provider, ranking, output, and
handoff contracts.

Provider listener/popularity enrichment remains owned by issue #204. Discovery quarantine is
invocation state, not durable plan/apply state.

## Create a Profile Plan

Assign a quality profile, a metadata profile, or both:

```bash
rfmedia lidarr plan artist-profiles \
  --ids 12,34 \
  --quality-profile 3 \
  --metadata-profile "name:Standard" \
  --max-batch 25 \
  --plan-file ./lidarr-profile-review.json
```

At least one of `--quality-profile` or `--metadata-profile` is required. Profile assignment is
medium risk because it can change future acquisition and refresh behavior. It does not change
existing files, monitoring state, download-queue entries, or trigger a search.

## Create a Tag Plan

Choose exactly one tag mode:

```bash
# Preserve unrelated tags and add the requested tags
rfmedia lidarr plan artist-tags --all \
  --add-tag Favorites \
  --add-tag 14 \
  --plan-file ./lidarr-tags-add.json

# Preserve unrelated tags and remove the requested tags
rfmedia lidarr plan artist-tags --select-unmonitored \
  --remove-tag "name:Needs Review" \
  --plan-file ./lidarr-tags-remove.json

# Replace the complete tag set
rfmedia lidarr plan artist-tags --ids 12,34 \
  --set-tag Favorites \
  --set-tag 14 \
  --plan-file ./lidarr-tags-set.json

# Explicitly replace the complete tag set with no tags
rfmedia lidarr plan artist-tags --ids 12,34 \
  --clear-tags \
  --plan-file ./lidarr-tags-clear.json
```

`--add-tag`, `--remove-tag`, and `--set-tag` are repeatable and require at least one tag.
`--clear-tags` accepts no tag value; an empty tag list never implies clearing.

Add and remove are low-risk delta operations and preserve unrelated assignments. Set and clear are
high-risk replacements: the preview lists assignments that will be removed, and real apply also
requires `--allow-tag-replacement`.

## Select Artists and Resolve Resources

Profile, tag, and artist-delete plans require exactly one selection mode:

- `--ids <ids>` selects unique, known, positive artist IDs.
- One or more `--select-*` options select from a fresh complete artist list.
- `--all` explicitly selects the complete library.

IDs, filters, and `--all` are mutually exclusive. Filters combine with AND semantics:
`--select-monitored`, `--select-unmonitored`, `--select-quality-profile`,
`--select-metadata-profile`, and repeatable `--select-tag`. Repeated tag filters use all-of
semantics.

For example, this considers only monitored artists that already have both named tags:

```bash
rfmedia lidarr plan artist-profiles \
  --select-monitored \
  --select-tag Favorites \
  --select-tag "Needs Review" \
  --quality-profile Lossless
```

Profile and tag references have deterministic meaning:

- a positive decimal string is a resource ID;
- other text is a trimmed, case-insensitive exact name or label;
- `name:<value>` forces name lookup, including for a numeric name.

Unknown or ambiguous references fail. Resolution never creates tags. A stable resource ID remains
authoritative if its display name changes after planning; apply shows a rename warning. A deleted
referenced resource blocks the run before any write.

Planning resolves the complete cohort before enforcing `--max-batch`. The default is 25 and the
hard maximum is 1,000; selection is never silently truncated. Zero matches fail without writing an
artifact. A non-empty cohort that is already fully converged succeeds, writes an auditable plan,
and causes no editor calls during apply.

Exact-ID monitoring remains available:

```bash
rfmedia lidarr plan artist-monitoring \
  --ids 12,34 \
  --unmonitored \
  --max-batch 25 \
  --plan-file ./lidarr-monitoring-review.json
```

Use `--monitored` for the inverse desired state.

## Create an Artist Delete Plan

Artist deletion is always explicit and bounded. Iterate with a planning dry-run, review the
complete Lidarr-reported evidence, and then seal the chosen file mode:

```bash
# Preview a keep-files plan; no artifact is written
rfmedia lidarr plan artist-delete --ids 12,34 --dry-run

# Seal the keep-files default
rfmedia lidarr plan artist-delete --ids 12,34 \
  --plan-file ./lidarr-artist-delete.json

# Seal an explicit delete-files plan selected by AND-combined filters
rfmedia lidarr plan artist-delete \
  --select-unmonitored \
  --select-tag Archive \
  --delete-files \
  --max-batch 25 \
  --plan-file ./lidarr-artist-delete-files.json
```

Exactly one of `--ids`, one or more `--select-*` filters, or `--all` is required. IDs and `--all`
conflict with every filter. Filters combine with AND semantics, including all-of semantics for
repeatable `--select-tag`. `--select-monitored` and `--select-unmonitored` conflict with each other.
The complete cohort is resolved before `--max-batch`; zero matches and over-limit cohorts fail
without truncation.

Omitting `--delete-files` seals `deleteFiles: false`, displays `keep-files`, and asks Lidarr to
remove its artist and cascading album records while retaining managed files. `--delete-files`
seals `deleteFiles: true`, displays `delete-files`, and asks Lidarr to remove its managed files as
part of the deletion. The file mode is plan-wide and cannot be changed during apply.
`artist-delete` accepts no album selector or album ID; a targeted album-management and deletion
command remains owned by [issue #223](https://github.com/yandy-r/rfmedia-apps/issues/223).

Every selected artist must have complete Lidarr-reported review evidence:

- artist name and stable Lidarr ID;
- a non-empty path;
- non-negative album and track-file counts; and
- non-negative exact bytes on disk.

Zero counts and zero bytes are valid. Missing or malformed evidence blocks planning. Human and
machine previews show the per-artist values and aggregate artist, album, track-file, and byte
totals. These values describe Lidarr's view of managed impact; they do not guarantee reclaimed disk
blocks. `rfmedia` does not traverse, stat, unlink, trash, or recursively delete local media paths.
Lidarr remains the only filesystem authority, through the reviewed `deleteFiles` request value.

## Create an Album Monitoring Plan

The `album-monitoring` operation kind plans album-level monitoring changes by album-type selector
or by exact album ID. Iterate with `--dry-run` first — it builds the selection and count summaries
in memory and writes no artifact — then drop the flag to seal the reviewed plan:

```bash
# Iterate: selection preview with count summaries, writes nothing
rfmedia lidarr plan album-monitoring --unmonitored --types singles,eps --dry-run

# Seal the reviewed plan (optionally scoped to specific artists)
rfmedia lidarr plan album-monitoring --unmonitored --types singles,eps --artist-ids 12,34
```

`--types` accepts a closed, case-insensitive selector vocabulary; singular aliases are accepted
and canonicalized. Primary-type selectors: `albums`, `eps`, `singles`, `broadcasts`, `others`.
Secondary-type selectors: `compilations`, `live`, `remixes`, `soundtracks`, `demos`, `mixtapes`.
Unknown tokens fail with the allowlist. `--artist-ids` optionally scopes a selector scan;
`--album-ids` selects exact albums instead and conflicts with the selector flags. Exactly one of
`--monitored` or `--unmonitored` is required, and at least one of `--types` or `--album-ids` — a
bare direction flag never plans anything. Album plan entries contain only albums whose monitored
state differs from the desired state; the selection summary still reports the full matched and
already-in-state counts.

Reversal needs no new machinery: every entry embeds its before state, so undo is either the
inverse plan (the opposite direction flag over the same selectors) or a precise reversal of
exactly what a previous plan changed:

```bash
rfmedia lidarr plan album-monitoring --monitored \
  --album-ids "$(jq -r '[.entries[].albumId]|join(",")' <old-plan>.json)"
```

## Create an Album Edit Plan

The `album-edit` operation kind plans targeted release-policy changes — it flips only an album's
`anyReleaseOk` value and touches nothing else. Selection mirrors album monitoring: `--album-ids`
selects exact albums, or `--types` selects by album-type selector, optionally scoped by
`--artist-ids`. Exactly one desired change is required — `--any-release-ok` or `--no-any-release-ok`
— and monitoring changes are rejected with a hint to use `plan album-monitoring`.

```bash
# Preview which albums would change, writing nothing
rfmedia lidarr plan album-edit --artist-ids 42 --types albums --any-release-ok --dry-run

# Seal a plan that requires the monitored release for the matched albums
rfmedia lidarr plan album-edit --artist-ids 42 --types albums --no-any-release-ok \
  --plan-file ./edit.json
```

Album-edit is medium risk and non-destructive: it changes no files, monitoring state, or
download-queue entries. Entries are changes-only — an album whose current `anyReleaseOk` already
equals the desired value is reported in the summary but produces no entry. If Lidarr omits
`anyReleaseOk` for a matched album, planning fails closed rather than guessing the current state.
Applying an edit plan needs no authorization flag; it keeps the standard review, confirm, and
`--yes` flow, and apply verifies the new value with fresh targeted reads.

## Create an Album Delete Plan

The `album-delete` operation kind is the first file-destructive Lidarr lane. It removes albums from
the Lidarr library and, when authorized, permanently deletes their track files. Selection is one of
two modes:

- `--album-ids` selects exact albums to delete; or
- `--artist-ids` selects an artist's albums, optionally narrowed by `--types`.

There is deliberately **no `--all`** — a library-wide destructive sweep is unexpressible at the plan
leaf. A selector scan without `--artist-ids` is rejected: album deletion requires an explicit
`--album-ids` or `--artist-ids` scope. Monitored albums are **excluded by default** and counted as
`excludedMonitored` in the selection summary; pass `--include-monitored` to opt them in.

The **destruction mode is sealed into the checksummed artifact at plan time** and cannot be
escalated at apply. Two independent flags decide it:

- `--delete-files` — permanently delete the track files on disk (default off: library-removal only);
- `--add-import-list-exclusion` — also exclude the deleted albums from import lists (default off).

```bash
# Preview a library-removal delete plan, writing nothing
rfmedia lidarr plan album-delete --artist-ids 12 --types demos,mixtapes --dry-run

# Seal a plan that also deletes files on disk
rfmedia lidarr plan album-delete --album-ids 4501,4502 --delete-files \
  --plan-file ./del.json
```

Each planned album seals its `trackFileCount`, `sizeOnDisk`, `monitored` state, and `foreignAlbumId`
into the before-state. Apply classifies a target whose `foreignAlbumId` or monitored state no longer
matches as drifted and blocks it — nothing is dispatched against a wrong or changed target.

### Two-Key Destructive Authorization

Deletion uses a two-key ceremony that is independent of the `--yes` approval:

```bash
# Library-removal apply: album-deletion authorization is required
rfmedia lidarr apply ./del.json --yes --allow-album-delete

# File-deleting apply: the sealed --delete-files plan additionally needs file-deletion authorization
rfmedia lidarr apply ./del.json --yes --allow-album-delete --allow-file-delete
```

`--allow-album-delete` is required for any real (non-dry-run) apply of an album-delete plan.
`--allow-file-delete` is **additionally** required when the sealed plan carries
`--delete-files`, because a plan can be applied later by a script that never saw the plan flags, so
on-disk destruction gets its own apply-time acknowledgment. Both are **authorization**, enforced at
the command and action layers and never satisfied by the `--yes` **approval**. A dry-run apply needs
neither, so review stays frictionless.

| Apply flag                | Required when                                       | Purpose                                              |
| ------------------------- | --------------------------------------------------- | ---------------------------------------------------- |
| `--allow-tag-replacement` | The plan is an artist tag set or clear              | Authorize destructive replacement of the tag set     |
| `--allow-album-delete`    | The plan is `album-delete` (any real apply)         | Authorize removing albums from the Lidarr library    |
| `--allow-file-delete`     | The sealed `album-delete` plan has `--delete-files` | Additionally authorize permanent track-file deletion |

### Idempotent, Verified Deletion

An already-deleted album is treated as satisfied, not stale, at every stage: whole-plan preflight,
per-entry admission from a fresh read, resume, and deferred replay all classify a missing target as
safely satisfied and record it in durable history so a rerun skips it. A dispatch or replay that
returns not-found is likewise recorded as satisfied. The client never swallows a `404` — it
propagates the failure at the boundary, and the already-deleted semantics live in the apply layer
with history evidence.

After dispatch, apply performs bounded absence verification (a small number of fresh
`listAlbums({albumIds})` reads): an album still present after a delete dispatch is recorded as
`failed` with structured verification evidence, and a transient verification error is recorded as
`uncertain` rather than a false success. A retryable failure that may have occurred before dispatch
is saved as deferred work keyed by its idempotency key; deletion is never hot-retried in place.

Deleting an album does not stop an import list from re-adding it later. When that matters, pass
`--add-import-list-exclusion` at plan time; the plan render surfaces this as a risk-cascade line.

### Scope Boundary vs File-Aware Bulk Delete (#200)

This suite's deletion is **album-scoped**. Artist-level file-aware bulk delete remains open in
[#200](https://github.com/yandy-r/rfmedia-apps/issues/200) and will reuse the `--allow-file-delete`
authorization flag and the album operation-definition patterns introduced here.

## Review, Check, and Apply

Human plan and apply previews show the canonical Lidarr origin, plan identity and checksum,
operation, selector, cap, risk, matched/changed/unchanged counts, and exact managed before/after
state. Profile names and tag labels are paired with stable IDs. Tag plans include added, retained,
and removed assignments. Artist-delete plans name the keep-files or delete-files mode and show the
complete Lidarr-reported path/count/byte evidence. Human output shows 20 artists by default;
`--verbose` shows all artists. The sealed artifact and every machine format retain the complete
bounded cohort.

```bash
# Revalidate schema, checksum, origin, resources, and live state; write nothing
rfmedia lidarr apply ./lidarr-profile-review.json --dry-run

# Check the reviewed artist-delete evidence without authorization or mutation
rfmedia lidarr apply ./lidarr-artist-delete-files.json --dry-run

# Interactive text apply: live review, then a default-no confirmation
rfmedia lidarr apply ./lidarr-profile-review.json

# Non-interactive or machine-output apply
rfmedia --output json lidarr apply ./lidarr-profile-review.json --yes

# Tag set/clear needs both general approval and replacement authorization
rfmedia lidarr apply ./lidarr-tags-set.json --yes --allow-tag-replacement

# Interactive keep-files deletion: authorization is still mandatory
rfmedia lidarr apply ./lidarr-artist-delete.json --allow-artist-delete

# Non-interactive file deletion requires both destructive authorizations
rfmedia lidarr apply ./lidarr-artist-delete-files.json \
  --allow-artist-delete \
  --allow-file-delete \
  --yes
```

`--yes` is mandatory when stdin is not interactive or a machine format is selected.
`--allow-tag-replacement` is independent of interactive confirmation and is mandatory for tag set
and clear. Real artist deletion independently requires `--allow-artist-delete`; a delete-files plan
also requires `--allow-file-delete`. The allow flags authorize the reviewed destructive effects,
while `--yes` only bypasses the default-no prompt. Supplying one never implies another. The same
allow flags remain mandatory on resume. Automation can additionally pin the reviewed artifact with
`--expected-plan-id` and `--expected-plan-checksum`.

Planning and apply have distinct dry runs:

- `rfmedia lidarr plan artist-delete ... --dry-run` resolves the complete cohort and builds the
  review output in memory, but writes no plan artifact.
- `rfmedia lidarr apply <plan> --dry-run` validates the existing artifact, origin, and live state,
  but acquires no claim and writes no history, Lidarr mutation, filesystem change, import-list
  exclusion, or Plex scan.

Apply fails closed when the artifact targets a different canonical Lidarr origin, its checksum or
schema is invalid, a target disappeared, or a target changed to an unexpected state after planning.
Staleness findings carry per-kind codes: `artist-missing`/`artist-state-drift` for artist plans and
`album-missing`/`album-state-drift` for album plans. A target already at the desired state is
recorded as safely satisfied. Missing or renamed profile/tag resources are also checked before an
artist profile or tag write is admitted.

Artist-add reverses the usual pre-existing-target assumption. Fresh absence of each sealed MBID is
ready for dispatch. An existing artist whose observable root/profile/monitoring policy matches its
entry is satisfied; an existing artist with conflicting identity or policy is drift and blocks the
run. Apply revalidates the shared sealed resources before dispatch and retains the artifact's entry
order.

For artist deletion, whole-plan preflight compares every live path, album count, track-file count,
and byte count with the sealed evidence before the first mutation. Apply then makes a fresh targeted
read immediately before each delete. Any evidence change at either boundary is stale, stops further
admission, and requires a newly generated plan. The artist name is a display label; the stable ID
and deletion evidence remain authoritative if the name changes.

## Write Verification and Recovery

Real apply performs one whole-plan preflight before mutation. Each target is reread immediately
before its single-target request and verified with up to three fresh targeted reads, 100 ms apart.
The terminal outcome is recorded durably before the next target is admitted.

Mutation requests are not automatically retried. For deferable operation kinds, a retryable failure
known to occur before dispatch can be saved as deferred work. After a request may have been
dispatched, apply reconciles the live managed state instead of blindly replaying it.

Artist-add uses an expected-absence, non-deferable path for each admitted entry:

1. reread and classify the exact MusicBrainz ID and sealed resources;
2. durably record that the entry may be dispatched while the apply claim is owned;
3. send one generated artist-create request with the sealed monitored value, new-item monitoring
   disabled, and missing-album search disabled;
4. read back by exact MusicBrainz ID;
5. when selectors are sealed, durably record that creation is verified but normalization remains,
   read only that artist's albums, and unmonitor currently monitored OR-matches in bounded batches;
6. durably record verification-pending before each album mutation and re-read the artist's albums;
   and
7. record success only when the authoritative artist state matches and no selected album remains
   monitored.

A lost response can be reconciled as success when the exact-MBID read proves the desired artist.
If absence, a conflicting artist, cancellation, or a read failure leaves dispatch inconclusive,
apply records `uncertain`, stops admissions, marks every later pending entry `not-attempted`, and
prints a pinned resume command. Artist-add is never automatically retried, never enters the
deferred queue, and is never resent by resume.

Post-add normalization is independently resumable. Machine results expose
`creation-verified-normalization-pending` or `normalization-verification-pending`, and the overall
real apply is `partial` until the entry reaches `completed`. A bounded artist-scoped read that
returns no albums is inconclusive, not proof that normalization is complete: apply stops later
admissions, persists the incomplete stage, and directs the operator to `--resume`.

On multi-entry resume, terminal entries are `skipped-resume`. Before any fresh entry can be
admitted, apply reconciles all pending entries that have matching durable possible-dispatch
evidence. A reconciled exact-MBID desired state is `satisfied`; absence or conflicting/inconclusive
state remains `uncertain`. The first uncertainty stops reconciliation and fresh admission, so all
later pending entries are `not-attempted`. This ordering prevents a fresh create from overtaking an
older dispatch whose outcome is unknown.

Artist deletion uses a stricter non-deferable path:

1. reread and reclassify the exact artist immediately before dispatch;
2. durably record that this plan and entry may be dispatched;
3. send one generated single-ID delete request with the sealed `deleteFiles` value and import-list
   exclusion disabled;
4. perform the bounded targeted verification reads; and
5. record `succeeded` only when an authoritative targeted not-found proves absence.

The delete response body is not proof of completion. Authentication, authorization, timeout,
cancellation, malformed response, and transport failures never imply absence. Artist deletion is
sequential, has no automatic mutation retry, creates no deferred intent, and is never replayed by
the generic deferred queue. Verification reads reconcile state; they do not repeat the delete.

Late drift, a lost apply claim, post-dispatch cancellation, failed verification, or an inconclusive
post-dispatch state stops later admissions. An inconclusive result is recorded as `uncertain`, not
as a definite success or failure. Use the copy-pasteable recovery command printed by apply:

```bash
rfmedia lidarr apply ./lidarr-artist-delete-files.json \
  --resume \
  --allow-artist-delete \
  --allow-file-delete \
  --expected-plan-id <plan-id> \
  --expected-plan-checksum <checksum>
```

Add `--allow-tag-replacement` when resuming a set or clear plan, and add `--yes` for
non-interactive use. Artist deletion resume also requires `--allow-artist-delete` and, for a
delete-files plan, `--allow-file-delete`.

Artist-add resume needs no destructive authorization flag. It requires matching durable
possible-dispatch or incomplete-normalization evidence and reconciles each affected target by exact
MusicBrainz ID:

```bash
rfmedia lidarr apply ./artist-add.json \
  --resume \
  --expected-plan-id <plan-id> \
  --expected-plan-checksum <checksum>
```

Add `--yes` for non-interactive use. Do not rerun discovery with `--add` or manually repeat the
create to recover an uncertain dispatch. If creation is already verified, resume uses the durable
Lidarr artist ID, rereads the artist-scoped albums, verifies any possibly dispatched batch, and
updates only remaining monitored matches. Normalization never authorizes or sends a second artist
POST.

Deletion outcomes distinguish evidence and timing:

- `succeeded` means this invocation sent the delete and targeted verification then proved absence.
- `satisfied` on resume means the artist is absent and matching durable possible-dispatch evidence
  from this exact plan ID, checksum, entry, and idempotency key makes that absence attributable.
- `skipped-resume` means a terminal durable success or satisfaction was already recorded.
- An artist absent on initial apply, or absent on resume without matching possible-dispatch
  evidence, is stale because the reviewed file effect cannot be proven.
- `uncertain` means dispatch or verification could not be established conclusively. Later entries
  are not admitted; use the printed pinned resume command instead of manually repeating a delete.

For deferable operations, resume rereads live state, skips durable successes and satisfied targets,
and replays only deferred work whose operation, payload, and idempotency key exactly match the plan.
This includes artist monitoring, album monitoring, profile assignment, and tag mutation, but never
artist deletion. Status, health, startup, and unrelated commands never replay mutation intents.

Only one real process may apply a plan at a time. Per-plan claims reject a concurrent live owner
and recover only a demonstrably stale owner.

## Optional Plex Scan

`--plex-scan` is apply-time intent and is not stored in the plan, checksum, history, or resume data:

```bash
rfmedia lidarr apply ./lidarr-artist-delete-files.json \
  --allow-artist-delete \
  --allow-file-delete \
  --plex-scan \
  --yes
```

One best-effort full-library scan is eligible after at least one newly `succeeded` delete-files
entry has non-zero reviewed track-file count or bytes. A qualifying partial apply is still eligible.
Keep-files plans, zero-impact results, resume-only `satisfied` results, and apply dry-runs skip the
scan. An unavailable adapter or failed scan is reported as separate scan status and warning. It
does not roll back, reclassify, or replay any Lidarr deletion.

## Artifact and Secret Handling

Version 3 artifacts bind the canonical target origin, normalized selection, resolved resource IDs
and labels, operation and mode, cap, exact ordered before/after state, deletion evidence, tag
deltas, risk facts, target order, per-target idempotency keys, and cascade analysis under a
canonical SHA-256 payload checksum. The checksum detects corruption; it is not an authenticated
signature. Trust the artifact source and inspect it before apply.

Plan and history storage uses private directories/files (`0700`/`0600`), bounded reads, no-follow
opens, exact-key validation, and atomic no-overwrite plan creation. Plans can reveal operational
metadata such as artist names, paths, MusicBrainz IDs, Last.fm provenance, file-impact counts,
profile names, tag labels, and the credential-free Lidarr origin, so retain them as private data.

Legacy v1/v2 artifacts retain exact validation and checksum semantics. They do not contain
`cascadeAnalysis`; readers do not upgrade them or derive estimates from current configuration.
Older CLIs that do not recognize v3 fail closed with a validation error instead of applying
anything.

API keys, authorization headers, raw response bodies, and credential-bearing URLs are never
persisted in plans, history, deferred payloads, logs, or output. Prefer configured secret templates
or environment injection over placing `--lidarr-api-key` in shell history.

## Output Formats

Human review and diagnostics use stderr. `--output json`, `yaml`, or `csv` emits one stable
`lidarr-plan` or `lidarr-apply` document on stdout. Machine output includes the complete cohort;
JSON/YAML preserve the complete structured sealed cascade analysis, while CSV uses bounded
aggregate `result.cascade.*` fields and the shared safe serializer. Legacy plans explicitly report
`not-recorded`. Partial and failed real applies set a non-zero exit code. Advisory cascade warnings
do not change the exit code or require an override. A successful dry-run reports status `checked`.
