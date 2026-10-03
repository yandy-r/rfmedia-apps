# Lidarr Artist Bulk Management: UX Research

## Executive Summary

Bulk profile and tag changes should extend the existing Lidarr plan/apply workflow rather than add
a second mutation path. The safest and most learnable shape is:

```text
select -> resolve names to IDs -> preview exact before/after state -> save sealed plan
       -> revalidate live state -> approve -> bulk edit -> verify -> report/recover
```

The recommended command family is one composable artist-edit plan operation:

```bash
rfmedia lidarr plan artist-edit \
  --where-tag premium \
  --quality-profile Lossless \
  --metadata-profile Standard \
  --add-tag cli-managed

rfmedia lidarr apply .rfmedia/plans/lidarr-....json --dry-run
rfmedia lidarr apply .rfmedia/plans/lidarr-....json
```

This keeps selection, desired state, approval, replay protection, and recovery vocabulary coherent
with the shipped `lidarr plan artist-monitoring` and `lidarr apply` commands. The operation should
allow quality profile, metadata profile, and tag add/remove changes in one atomic user intent. Tag
replacement should be a separately spelled, high-friction operation because Lidarr implements
replacement by discarding every existing tag not in the submitted set.

The local baseline already supplies most safety primitives:

- a sealed, checksummed plan with explicit target origin and per-artist before/after state;
- a default batch cap of 25 and an absolute cap of 1,000;
- interactive apply that performs a live dry-run before approval and binds approval to the reviewed
  plan ID and checksum;
- plan-staleness detection, exclusive apply claims, durable per-entry history, `--resume`, uncertain
  outcome handling, and structured JSON/YAML/CSV output;
- terminal-control rejection for untrusted artifact text and TTY-aware prompting.

The principal UX work is therefore selection clarity, profile/tag name resolution, richer review
summaries, destructive-replacement consent, and truthful verification after one or more bulk editor
requests.

**Confidence**: High — confirmed in the current repository's command, action, plan engine, type, and
completion implementations, plus the current Lidarr API and frontend source.

Current Lidarr provides a useful but less safe comparison. Its artist index supports selection and
custom filters, its mass edit dialog can change both quality and metadata profiles, and its tag
dialog supports add/remove/replace with a visual result. It applies directly, however: the source
does not show a durable dry-run artifact, drift gate, or per-artist before/after verification. An
older project finding that Lidarr's mass editor cannot change metadata profiles is stale; the
current dialog and API both support it.

**Confidence**: High — the official frontend and controller source agree. The comparison is against
the `develop` snapshot at commit
[`3d48a98`](https://github.com/Lidarr/Lidarr/tree/3d48a982d2addf5a84d22224c3ea03778cd8dc95),
dated 2026-07-12.

## User Workflows

### Discover available selectors and values

Users should not need to discover numeric Lidarr IDs in another tool. Help and completion should
show the selector/action split and provide an explicit value-discovery route:

```bash
rfmedia lidarr plan artist-edit --help
rfmedia lidarr list --output json
rfmedia lidarr profiles list
rfmedia lidarr tags list
```

If separate `profiles list` and `tags list` commands are outside issue #199, `artist-edit --help`
should at minimum explain that exact names or numeric IDs are accepted, and an unknown value error
should print the valid names. Shell completions should include the new subcommand and static option
names across Bash, Zsh, and Fish; dynamic remote value completion is optional because it introduces
latency, credentials, and network failure into shell completion.

Recommended selection vocabulary:

| Purpose                 | Option                                  | Semantics                                               |
| ----------------------- | --------------------------------------- | ------------------------------------------------------- |
| Exact selection         | `--ids <id,...>`                        | Exact unique Lidarr artist IDs                          |
| Tag filter              | `--where-tag <id-or-name>` repeatable   | Artist must contain all specified tags                  |
| Quality profile filter  | `--where-quality-profile <id-or-name>`  | Exact current assignment                                |
| Metadata profile filter | `--where-metadata-profile <id-or-name>` | Exact current assignment                                |
| Monitoring filter       | `--monitored` / `--unmonitored`         | Preserve existing mutually exclusive vocabulary         |
| Whole library selection | `--all`                                 | Explicit consent to consider every artist               |
| Safety bound            | `--max-batch <n>`                       | Refuse when matched targets exceed the reviewed maximum |

Use exactly one selection mode: `--ids`, a set of `--where-*` filters, or `--all`. Multiple
`--where-*` filters combine with AND; repeated `--where-tag` means “has every tag.” Reject `--ids`
combined with filters instead of silently intersecting or unioning them. Never reuse a display
`--limit` as a mutation boundary: selection must evaluate the complete live artist list, while
`--max-batch` is an explicit refusal threshold.

The explicit `--all` requirement prevents a missing environment variable such as
`--where-tag "$TAG"` from becoming an accidental whole-library operation. The option name
`--where-tag` also distinguishes selection from `--add-tag`, `--remove-tag`, and
`--replace-tags`.

**Confidence**: High for the need for explicit/consistent selection; Medium for the exact option
names, which are a product decision. Lidarr's current custom filter builder includes monitored
state, quality profile, metadata profile, tags, dates, path, genres, ratings, and statistics in
[`artistIndexActions.js`](https://github.com/Lidarr/Lidarr/blob/3d48a982d2addf5a84d22224c3ea03778cd8dc95/frontend/src/Store/Actions/artistIndexActions.js).
The local CLI already uses AND semantics for repeated tag IDs in `lidarr list`.

### Plan a profile and additive tag change

```bash
rfmedia lidarr plan artist-edit \
  --where-tag premium \
  --unmonitored \
  --quality-profile Lossless \
  --metadata-profile Standard \
  --add-tag review-complete \
  --max-batch 100
```

Recommended human output:

```text
Lidarr Artist Edit Plan

Selection: tag "premium" AND unmonitored
Resolved: tag premium (id 7)
Matched: 42 artists (cap 100)
Plan: 9b8c...  Target: http://lidarr:8686

Changes
  Quality profile:  Standard (id 2) -> Lossless (id 5)      38
  Metadata profile: Mixed -> Standard (id 1)                11
  Tags:             add review-complete (id 12)             40
  Already desired / no-op                                  2

ARTIST ID  ARTIST                  QUALITY             METADATA          TAGS
17         Autechre                Standard -> Lossless Standard          +review-complete
28         Boards of Canada        Lossless             None -> Standard  +review-complete
...

42 matched, 40 changed, 2 unchanged
Plan saved to: .rfmedia/plans/lidarr-2026-07-23T...json
Next: rfmedia lidarr apply <path> --dry-run
```

The compact summary should count changes by field, not only changed artists. A single artist may
contribute to several field counts. The artifact and machine output retain complete entries; text
mode may show the first 20 and state how many were omitted, with `--verbose` showing all.

Resolve exact names to IDs at plan time, reject ambiguous duplicate names, and store both immutable
IDs and review-time labels. Apply binds to IDs and displays labels for comprehension. If a profile
or tag has been deleted or renamed, apply should distinguish identity loss (blocking) from a display
name change (warning or drift policy decision).

**Confidence**: High for showing exact before/after state and binding IDs; Medium for truncation at
20 rows. Terraform's official plan workflow likewise compares current and desired state, reports an
explicit no-change result, and can save a reviewed plan for later apply
([Terraform plan reference](https://developer.hashicorp.com/terraform/cli/commands/plan), accessed
2026-07-23).

### Dry-run and interactive apply

The existing apply behavior is the right default:

```bash
rfmedia lidarr apply .rfmedia/plans/lidarr-....json
```

In an interactive terminal it should:

1. read and validate the sealed artifact;
2. fetch live artists, profiles, and tags;
3. reject missing targets or drifted before-state;
4. render the same before/after review with current classifications;
5. ask for approval bound to the reviewed plan ID and checksum;
6. apply only after approval.

`--dry-run` should perform steps 1-4, return `status: "checked"`, write no history or claim, and
classify every entry as `would-apply`, `satisfied`, `blocked-stale`, or `skipped-resume`. It must not
call `PUT /api/v1/artist/editor`.

For ordinary profile changes and tag add/remove:

```text
Apply 40 artist changes from plan 9b8c...? (y/N)
```

For tag replacement:

```text
DESTRUCTIVE TAG REPLACEMENT
42 artists selected; 73 existing tag assignments will be removed.
Replacement set: archive, lossless

Type "replace 42" to continue:
```

In non-interactive or machine-output mode, require `--yes`. For replacement, additionally require a
purpose-specific `--allow-tag-replacement` (or equivalent) so a generic automation alias containing
`--yes` cannot authorize an unexpected destructive operation. Both requirements should fail before
network mutation.

**Confidence**: High for dry-run-before-approval and no prompting outside a TTY; Medium for the
typed phrase and second automation flag. The open-source CLI Guidelines recommend dry-run plus
confirmation for complex bulk changes that are hard to undo, and higher-friction confirmation for
severe changes
([CLI Guidelines, Arguments and flags](https://clig.dev/#arguments-and-flags), accessed 2026-07-23).

### Add and remove tags

Tag add and remove are set operations:

```bash
rfmedia lidarr plan artist-edit \
  --where-quality-profile Lossless \
  --add-tag premium \
  --remove-tag legacy
```

The preview should show per-tag counts:

```text
+ premium:  31 will add, 8 already present
- legacy:   12 will remove, 27 already absent
```

Reject the same tag in both add and remove sets. Multiple add/remove values are legitimate. The plan
must preserve unrelated tags and show that guarantee in its risk summary.

**Confidence**: High — Lidarr's controller adds and removes individual tag IDs from each artist's
set; see
[`ArtistEditorController.cs`](https://github.com/Lidarr/Lidarr/blob/3d48a982d2addf5a84d22224c3ea03778cd8dc95/src/Lidarr.Api.V1/Artist/ArtistEditorController.cs).

### Replace or clear tags

Replacement must be mutually exclusive with add/remove:

```bash
rfmedia lidarr plan artist-edit \
  --where-tag legacy \
  --replace-tags premium,archive
```

Clearing all tags must use an explicit token rather than an empty shell value:

```bash
rfmedia lidarr plan artist-edit --where-tag temporary --replace-tags none
```

The plan should report:

- selected and changed artist counts;
- the replacement set by name and ID;
- total assignments added, retained, and removed;
- artists that will lose tags not named by the operator;
- `risk.level: "high"` and `risk.destructive: true`.

**Confidence**: High for replacement semantics; Medium for the `none` spelling. Lidarr assigns a new
tag set in its `ApplyTags.Replace` branch, so omitted tags are removed
([controller source](https://github.com/Lidarr/Lidarr/blob/3d48a982d2addf5a84d22224c3ea03778cd8dc95/src/Lidarr.Api.V1/Artist/ArtistEditorController.cs)).
The CLI Guidelines recommend a special word such as `none` for an explicit empty value rather than
an ambiguous blank argument ([CLI Guidelines](https://clig.dev/#arguments-and-flags)).

### No matches and no changes

These are different outcomes:

- **Zero matches**: fail before writing an actionable plan. State the normalized selector and
  suggest `rfmedia lidarr list` with equivalent filters. This most often indicates a typo, stale
  profile/tag name, or unintended AND semantics.
- **Matches, all already desired**: succeed with an explicit no-op: `42 matched; no changes needed.`
  The review result remains machine-readable. A plan artifact may be retained for audit, but apply
  should not prompt or issue a mutation request.
- **Mixed**: include unchanged entries for a truthful denominator, classify them as `satisfied`,
  and execute only changed entries.

If automation needs to distinguish “changes present,” add an opt-in detailed exit mode rather than
changing the repository's existing exit meanings. Terraform's `-detailed-exitcode` precedent is
0 for empty diff, 1 for error, and 2 for non-empty diff, but rfmedia must preserve its own global
contract ([Terraform plan reference](https://developer.hashicorp.com/terraform/cli/commands/plan)).

**Confidence**: High — explicit no-op feedback avoids treating a successful converged state as an
error, while zero matches is sufficiently likely to be a selector mistake that it should block.

### Automation and JSON output

```bash
rfmedia --output json lidarr plan artist-edit \
  --where-tag-id 7 \
  --quality-profile-id 5 \
  --plan-file artist-edit.json

rfmedia --output json lidarr apply artist-edit.json --dry-run
rfmedia --output json lidarr apply artist-edit.json --yes
```

Accepting explicit `*-id` forms alongside exact names is useful for stable scripts. Machine output
should emit exactly one document to stdout; diagnostics and progress stay on stderr. Suggested
fields:

```json
{
  "command": "lidarr-plan",
  "result": {
    "schemaVersion": "rfmedia.lidarr-plan.v2",
    "planId": "9b8c...",
    "planChecksum": "sha256:...",
    "planPath": "/absolute/path/artist-edit.json",
    "target": {
      "origin": "http://lidarr:8686"
    },
    "selection": {
      "mode": "filters",
      "predicates": [
        {
          "field": "tag",
          "operator": "contains",
          "id": 7,
          "label": "premium"
        }
      ]
    },
    "summary": {
      "matched": 42,
      "changed": 40,
      "unchanged": 2,
      "fieldChanges": {
        "qualityProfile": 38,
        "metadataProfile": 11,
        "tags": 40
      }
    },
    "risk": {
      "level": "medium",
      "destructive": false
    },
    "entries": []
  }
}
```

Apply output should preserve the current per-entry outcomes and add verification evidence, request
batch identity, and changed fields. Stable error codes should be script inputs; human messages may
evolve. Never expose the Lidarr API key, raw credential-bearing request, or secret source in an
artifact or result.

**Confidence**: High — the local command layer already separates machine stdout from human stderr
and requires `--yes` for machine-output apply. The CLI Guidelines likewise recommend primary and
machine-readable output on stdout, messaging on stderr, JSON support, and non-zero failure exit
codes ([CLI Guidelines, Basics and Output](https://clig.dev/#the-basics), accessed 2026-07-23).

### Recovery after interruption or partial outcome

The operator's primary recovery command should remain:

```bash
rfmedia lidarr apply <plan-file> --resume
```

On interruption or transport uncertainty:

1. stop admitting new batches;
2. re-read affected artists;
3. classify each as desired/satisfied, unchanged/ready, drifted, or unknown;
4. persist only outcomes supported by live evidence;
5. report an exact resume command and non-zero exit.

Do not advise blind re-execution of a lost-response bulk request. Tag add/remove and setting a
profile are naturally idempotent, but the history and live state still need reconciliation so the
operator can distinguish confirmed success from uncertainty. Replacement is also convergent, yet a
stale selection or wrong replacement set is too consequential for automatic broadening.

**Confidence**: High — this matches the existing local deferred-intent, uncertain-outcome,
per-entry-history, and resume model. The CLI Guidelines recommend that transient failures be
recoverable by rerunning and that Ctrl+C remain effective
([CLI Guidelines, Robustness and signals](https://clig.dev/#robustness), accessed 2026-07-23).

## CLI UX Best Practices/Accessibility

### Keep selection and mutation visually separate

Use `--where-*` for predicates and verbs for desired changes:

```text
--where-tag premium       # selects
--add-tag archive         # changes
--quality-profile FLAC    # changes
```

Help should group options under `Selection`, `Desired changes`, `Safety`, `Connection`, and
`Output`, with two or three complete examples. A bare `artist-edit` invocation should print concise
help and make no network call. Errors should suggest a corrected command but never infer a missing
mutating argument.

**Confidence**: High — discoverable examples and consistent subcommands/flags are recommended by
the CLI Guidelines ([Help](https://clig.dev/#help) and
[Subcommands](https://clig.dev/#subcommands)).

### Preserve names and IDs

Humans should see `Lossless (id 5)`, not only `5`; JSON should carry separate `id` and `label`
fields. Exact-name resolution must be case policy documented and deterministic. On duplicate exact
names, show all candidate IDs and require an ID. Never silently fuzzy-match a profile, tag, or
artist for a mutation.

**Confidence**: High — labels improve review comprehension, while IDs preserve stable API identity.

### Do not use color as state

Use words and symbols together:

```text
CHANGE   Standard -> Lossless
NO-OP    already Lossless
REMOVE   legacy
BLOCKED  profile id 5 no longer exists
```

Color may reinforce those words, but it must not be the only difference. Respect non-TTY output,
`NO_COLOR`, `TERM=dumb`, and a repository-level `--no-color` policy if available. Avoid cursor
control, animation, and spinner rewrites in CI, redirected stderr, and screen-reader-oriented usage.

**Confidence**: High — W3C WCAG 2.2 says color must not be the only means of conveying information
([Understanding Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color), updated
2026), and the `NO_COLOR` convention specifies that a non-empty `NO_COLOR` disables ANSI color
([NO_COLOR](https://no-color.org/), updated 2026-07-21).

### Make output readable at narrow widths

- Put the outcome word before decorative symbols.
- Avoid side-by-side tables when the terminal is narrow; fall back to one artist block per entry.
- Truncate display labels only in human tables, never in the plan or JSON.
- Do not rely on Unicode arrows; `->`, `+`, and `-` are safe plain-text fallbacks.
- Keep append-only progress in non-TTY mode so logs remain understandable when replayed.
- Print the final summary even after verbose progress.

**Confidence**: Medium — these are established terminal accessibility practices, but terminal width
and screen-reader behavior need empirical testing in this CLI.

### Keep prompts optional and scriptable

Only prompt when stdin is an interactive TTY. `--dry-run` never prompts. Machine output never
prompts. Non-interactive mutation without the required approval flags fails with a structured error
before mutation. Ctrl+C at a prompt means “cancelled; no changes made,” while Ctrl+C after mutation
starts means “interrupted; reconciliation required.”

**Confidence**: High — Node exposes TTY detection through `isTTY`
([Node.js TTY documentation](https://nodejs.org/api/tty.html)), and the CLI Guidelines recommend
prompts only with interactive stdin and an explicit non-interactive flag path
([Interactivity](https://clig.dev/#interactivity)).

## Error Handling

| Condition                         | Human message                                                                | Safe behavior                                  | Recovery / exit                                  |
| --------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| No selector                       | `Choose --ids, one or more --where-* filters, or explicit --all.`            | No network mutation; show concise help         | Correct command; usage exit                      |
| Conflicting selector modes        | `--ids cannot be combined with --where-* or --all.`                          | Reject before fetching                         | Choose one mode; usage exit                      |
| No desired change                 | `Specify at least one profile or tag change.`                                | Do not create an actionable plan               | Add desired state; usage exit                    |
| Unknown profile/tag               | `No quality profile named "Lossles". Available: Lossless (5), Standard (2).` | Do not fuzzy-select                            | Correct name/use ID; usage exit                  |
| Ambiguous name                    | `Tag "archive" resolves to IDs 7 and 12.`                                    | Do not guess                                   | Use explicit ID; usage exit                      |
| Zero matches                      | `0 artists match tag "premium" AND unmonitored.`                             | No plan/mutation                               | Show equivalent list command; operational exit   |
| Batch cap exceeded                | `142 artists match; plan cap is 100.`                                        | Refuse, never truncate                         | Narrow selector or explicitly raise cap          |
| All no-op                         | `42 matched; all already satisfy the requested state.`                       | No editor request and no prompt                | Exit 0; structured `changed: 0`                  |
| Add/remove conflict               | `Tag "legacy" cannot be both added and removed.`                             | Reject before plan                             | Correct desired state; usage exit                |
| Replace mixed with add/remove     | `--replace-tags is exclusive with --add-tag/--remove-tag.`                   | Reject before plan                             | Pick replacement or delta semantics              |
| Empty replacement ambiguous       | `Use --replace-tags none to clear all tags.`                                 | Reject blank value                             | Repeat explicit command                          |
| Replacement consent absent        | `Tag replacement requires --allow-tag-replacement with --yes.`               | No mutation                                    | Review dry-run, then authorize explicitly        |
| Profile/tag deleted after plan    | `Plan blocked: quality profile id 5 no longer exists.`                       | No bulk request                                | Recreate or regenerate plan                      |
| Artist missing/state drift        | `Plan stale: 3 artists changed after review.`                                | Block before mutation; enumerate entries       | Regenerate plan                                  |
| Artifact checksum/schema invalid  | `Plan refused: checksum mismatch.`                                           | Never attempt repair or mutation               | Regenerate from trusted command                  |
| Target origin mismatch            | `Plan targets lidarr-a; current config resolves lidarr-b.`                   | No mutation                                    | Use intended config or regenerate                |
| Prior history without resume      | `This plan has prior history; use --resume.`                                 | No duplicate work                              | Re-run with `--resume`                           |
| Concurrent apply claim            | `Plan is already being applied by another process.`                          | Do not wait indefinitely or steal a live claim | Inspect/wait, then resume                        |
| Lidarr validation error           | `Batch 2 rejected: metadata profile id 8 is invalid.`                        | Stop new batches; no blind retry               | Refresh profiles, reconcile, regenerate          |
| Auth/permission failure           | `Lidarr rejected credentials (401/403); no changes confirmed.`               | Stop immediately                               | Correct credential; resume only after live check |
| Timeout/rate limit before request | `Lidarr unavailable before batch 2; 25 changes remain.`                      | Stop admissions; bounded retry policy          | Show retry-after/resume command                  |
| Lost response after request       | `Batch 2 outcome is uncertain; reconciling live artist state.`               | Re-read; never label success without evidence  | Resume unresolved entries; exit 1                |
| Mixed verification result         | `30 confirmed, 2 drifted, 10 not attempted.`                                 | Preserve evidence and stop unsafe continuation | Regenerate for drifted/not-attempted             |
| Ctrl+C before mutation            | `Cancelled; no changes were made. Plan remains at ...`                       | Exit promptly                                  | Exit 0                                           |
| Ctrl+C during mutation            | `Interrupt received; stopping new batches and reconciling the active batch.` | Finish bounded reconciliation/history write    | Exit 1; print `--resume`                         |

The failure envelope should include stable `code`, `stage`, `planId`, `batchId`, affected artist IDs,
whether a request was sent, whether live verification completed, retryability, and
`retryAfterSeconds` when known. Human messages should always say whether changes may have occurred
and what command is safe next.

**Confidence**: High — these states follow the local plan validation, scheduler error taxonomy,
exclusive claims, staleness findings, and resume history. Lidarr validates quality and metadata
profile IDs in
[`ArtistEditorValidator.cs`](https://github.com/Lidarr/Lidarr/blob/3d48a982d2addf5a84d22224c3ea03778cd8dc95/src/Lidarr.Api.V1/Artist/ArtistEditorValidator.cs).

## Performance UX

Planning requires complete live collections, but it should make a bounded number of calls:

1. fetch all artists once;
2. fetch quality profiles, metadata profiles, and tags once as needed;
3. resolve selectors and desired values locally;
4. build and seal the plan without per-artist reads.

Apply should show monotonic phases:

```text
[1/4] Preflight     Fetching live artists and referenced profiles
[2/4] Revalidate    42 checked: 40 ready, 2 satisfied
[3/4] Apply         Batch 1/2: 25 artists accepted (1.3s)
[3/4] Apply         Batch 2/2: 15 artists accepted (0.8s)
[4/4] Verify        42/42 read back: 40 desired, 2 already satisfied
```

Use count-based progress, elapsed time, batch number, and bounded retry state. Do not invent a
percentage for an unbounded network wait. In a TTY, a spinner may accompany the phase label; in
plain output, emit a new line only on phase change, retry, material count change, or a reasonable
heartbeat.

The Lidarr endpoint accepts a list of artist IDs and one shared editor payload. Group artists only
when their desired mutation payload is identical. A multi-field plan with per-artist differences
may require several deterministic payload groups. Keep the reviewed `--max-batch` bound, split
larger approved sets into visible request batches, and verify every artist after the final request.
Do not issue one HTTP request per artist when the payload can be safely grouped.

**Confidence**: High for bulk payload support and bounded progress; Low for the ideal request batch
size because the official API publishes no practical maximum. The request resource exposes
`artistIds`, `qualityProfileId`, `metadataProfileId`, `tags`, and `applyTags`
([`ArtistEditorResource.cs`](https://github.com/Lidarr/Lidarr/blob/3d48a982d2addf5a84d22224c3ea03778cd8dc95/src/Lidarr.Api.V1/Artist/ArtistEditorResource.cs)),
and the controller returns `Accepted` after update. Empirical testing is required for latency,
maximum payload, partial failure, and response-loss behavior.

The CLI should print an initial phase within roughly 100 ms, then avoid noisy per-artist log lines.
The CLI Guidelines explicitly recommend immediate feedback, progress for long operations,
non-animated output when not a TTY, recoverability, and timeouts
([CLI Guidelines, Output and Robustness](https://clig.dev/#output), accessed 2026-07-23).

**Confidence**: High for the interaction recommendation; performance thresholds beyond initial
feedback require measurement against small, medium, and near-cap Lidarr libraries.

## Competitive Analysis

| Workflow                  | Strong pattern                                                                              | Gap/risk                                                                                | Recommendation for rfmedia                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Lidarr artist mass editor | Select mode, selected count, “No Change” fields, quality and metadata profile selectors     | Applies directly; no sealed review artifact or drift gate visible in source             | Keep selected/matched count and “unchanged” semantics, but route through plan/apply        |
| Lidarr tag modal          | Explicit add/remove/replace and an aggregate visual result                                  | Replacement can remove unrelated tags; aggregate result is not an exact per-artist diff | Show per-artist and aggregate add/retain/remove counts; elevate replacement risk           |
| Lidarr custom filters     | Rich filter builder includes monitored, profiles, tags, path, genres, dates, and statistics | GUI state is hard to reproduce in automation                                            | Start with deterministic profile/tag/monitor predicates and serialize normalized selection |
| Terraform plan/apply      | Saved review artifact, no-change message, detailed exit option, plan re-checking            | Infrastructure-oriented and saved plans may contain sensitive data                      | Reuse inspectable artifact and convergence language; keep API keys out of plans            |
| kubectl apply             | Label selectors, client/server dry-run, many machine output formats                         | Force/conflict semantics can be hazardous and output is object-centric                  | Keep one unambiguous live dry-run and explicit destructive replacement consent             |

Lidarr's current edit modal includes quality and metadata profile changes and displays the number of
selected artists
([`EditArtistModalContent.tsx`](https://github.com/Lidarr/Lidarr/blob/3d48a982d2addf5a84d22224c3ea03778cd8dc95/frontend/src/Artist/Index/Select/Edit/EditArtistModalContent.tsx)).
Its tag modal exposes add/remove/replace and visually marks existing, adding, and removing tags
([`TagsModalContent.tsx`](https://github.com/Lidarr/Lidarr/blob/3d48a982d2addf5a84d22224c3ea03778cd8dc95/frontend/src/Artist/Index/Select/Tags/TagsModalContent.tsx)).
The official controller confirms that one `PUT /api/v1/artist/editor` can change monitoring,
quality profile, metadata profile, root folder, or tags for selected IDs
([controller source](https://github.com/Lidarr/Lidarr/blob/3d48a982d2addf5a84d22224c3ea03778cd8dc95/src/Lidarr.Api.V1/Artist/ArtistEditorController.cs));
the official API explorer lists the artist editor PUT and DELETE endpoints
([Lidarr API docs](https://lidarr.audio/docs/api/), accessed 2026-07-23).

**Confidence**: High — these are first-party implementation sources. Freshness warning: individual
mass-editor source files were last materially changed in 2023-2025, but all remain present in the
2026-07-12 `develop` snapshot. Re-check against the repository's pinned OpenAPI snapshot during
implementation.

Terraform documents that a plan previews changes without applying them, can report no changes, and
can be saved for later execution; it also warns that live state can change between speculative plan
and apply ([Terraform plan reference](https://developer.hashicorp.com/terraform/cli/commands/plan)).
Kubernetes documents server/client dry-run, selectors, validation, and JSON/YAML output for
`kubectl apply`
([kubectl apply reference](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_apply/),
last modified 2026-03-22).

**Confidence**: High — current official product documentation; the recommendations are analogies,
not requirements.

## Recommendations

### Must

1. Extend the sealed Lidarr plan/apply model with an allowlisted artist-edit operation; do not add a
   direct unplanned mutation command.
2. Require an explicit selector mode: exact IDs, one or more `--where-*` filters, or `--all`.
   Evaluate the full live artist collection and never silently truncate matches.
3. Support quality profile, metadata profile, and tag add/remove desired state in one plan. Accept
   exact names for humans and explicit IDs for automation; store/display both.
4. Preserve deterministic filter semantics: AND across predicate families and all-of for repeated
   tags. Reject ambiguous combinations.
5. Render aggregate and per-artist before/after state, including matched, changed, unchanged, and
   per-field counts. Preserve unchanged entries as `satisfied`.
6. Keep `apply --dry-run` mutation-free and history-free. Interactive real apply must revalidate and
   render the live result before a default-no confirmation.
7. Make tag replacement mutually exclusive, high risk, and separately authorized. Show assignments
   added, retained, and removed; require explicit `none` to clear all tags.
8. Revalidate artist state and referenced profile/tag identities before the first write. Reject
   drift rather than silently recalculating a broader selection.
9. Use the generated Lidarr client facade for the official bulk editor request. Group only identical
   payloads, stop admissions on uncertainty, re-read affected artists, and record evidence per
   artist.
10. Keep one structured stdout document and human/progress stderr. Machine/non-TTY mutation requires
    `--yes`; tag replacement requires an additional purpose-specific authorization.
11. Provide stable machine error codes and exact recovery guidance. Preserve `--resume` as the
    normal interrupted/partial recovery command.
12. Update Bash, Zsh, and Fish completions and command help together. Include complete selection,
    additive tag, profile, replacement, dry-run, and resume examples.

**Confidence**: High — these are necessary to meet the issue's stated safe bulk editing and
before/after dry-run goals without weakening existing plan/apply guarantees.

### Should

1. Add read-only profile/tag discovery commands, or at minimum print valid names/IDs on resolution
   errors.
2. Add explicit `--where-quality-profile`, `--where-metadata-profile`, monitoring, and tag filters
   before expanding to dates, genres, paths, or statistics.
3. Print only a bounded number of rows by default in text mode while keeping full artifact/JSON
   entries and a `--verbose` expansion.
4. Add an opt-in detailed exit mode for automation that needs to distinguish converged from
   changes-present, without overloading existing exit codes.
5. Verify post-apply state with one full artist re-read and report desired/satisfied/drifted/unknown
   counts.
6. Use plain append-only progress outside a TTY; respect `NO_COLOR` and never use color alone.
7. Measure planning and apply against 25, 100, and 1,000 selected artists before raising defaults or
   adding concurrency.

**Confidence**: Medium — valuable for usability and automation, but some can ship incrementally
after the safe core.

### Nice

1. Dynamic shell completion for locally cached profile/tag names, only if it never blocks on a
   remote request.
2. A `lidarr plan show <file>` or equivalent inspect command for rendering saved plans without
   contacting Lidarr.
3. `--from-json` selector input for very large exact-ID sets, with the same schema validation and
   batch bounds.
4. Narrow-terminal and screen-reader-friendly display modes selected automatically from terminal
   capabilities.
5. An opt-in post-apply machine event stream in addition to the final JSON document, if long-running
   batches later justify it.

**Confidence**: Low to Medium — useful enhancements, not required to solve issue #199.

## Open Questions

1. Should the public command be `lidarr plan artist-edit`, separate `artist-profile` and
   `artist-tags` operations, or thin profile/tag aliases that compile to one artist-edit plan?
2. Does plan schema v1 permit additive operation variants, or should this feature introduce
   `rfmedia.lidarr-plan.v2` to avoid older clients misreading new entries?
3. Should profile/tag names be case-sensitive exact matches? How should duplicate labels from an
   unusual Lidarr instance be presented?
4. Are `--ids` plus `--where-*` filters worth supporting as explicit intersection, or is one
   selector mode safer and easier to teach?
5. Should repeated `--where-tag` mean all-of only, or is a separately named `--where-any-tag`
   needed in the first release?
6. Does issue #199 require artist-name/path/genre/statistics filters, or is parity with current
   `lidarr list` plus metadata-profile filtering sufficient initially?
7. Should zero matches be a usage exit or operational exit under the repository's exact exit-code
   contract?
8. Should an all-no-op plan artifact be written for audit, or should plan return the result without
   a reusable artifact?
9. What typed phrase and non-interactive flag best fit repository conventions for tag replacement?
10. Is `--replace-tags none` the desired clear-all spelling?
11. Should profile/tag rename between plan and apply block, warn while preserving ID binding, or be
    recorded as non-semantic drift?
12. Can one bulk editor request be treated transactionally by Lidarr under validation/database
    failures? This needs an integration test; controller inspection alone cannot prove rollback
    behavior.
13. What practical artist-ID limit does the target Lidarr version accept in one editor request?
    Keep the existing 25 default until measured.
14. How should grouped bulk requests map onto the current per-entry durable history and deferred
    intent model without losing individual reconciliation?
15. Does a successful `Accepted` response contain sufficiently strict artist projections for
    immediate verification, or should apply always perform an independent live re-read?
16. Can tag/profile changes trigger secondary Lidarr work on the supported version? The source
    suggests ordinary database updates, but this should be confirmed empirically before final risk
    text is frozen.
17. Should selection ever use stale cached artist data? Recommendation: no; mutation plans and apply
    preflight should require live local Lidarr state.
18. What human-output row limit and progress heartbeat work best at 80-column terminals and in CI
    logs?

**Confidence**: High that these are the unresolved decisions most likely to change the CLI contract
or safety model. Questions 12, 13, 15, and 16 require live Lidarr integration tests rather than more
source-only research.
